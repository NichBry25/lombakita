import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { logger } from "@/lib/logger";
import {
  generateUsername,
  type UsernameAvailabilityCheck,
  UsernameGenerationError,
} from "@/lib/username/generate";
import { getDb, type Database } from "@/server/db/client";
import {
  candidateProfiles,
  recruiterVerificationSubmissions,
  userEmailVerificationTokens,
  userPasswordCredentials,
  userProfiles,
  users,
} from "@/server/db/schema";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { sendRegistrationVerificationEmail } from "@/server/auth/email-verification";
import { meetsRecruiterTier } from "@/server/auth/recruiter-tier";
import {
  REGISTRATION_CODE_TTL_MS,
  hashRegistrationCode,
  issueRegistrationCode,
  registrationCodeMatches,
} from "@/server/auth/registration-code";
import {
  REGISTRATION_CODE_ATTEMPT_LIMIT,
  REGISTRATION_CODE_DAILY_LIMIT,
} from "@/server/auth/rate-limit-constants";
import { checkFixedWindowLimitFailClosed } from "@/server/redis/rate-limit";
import { claimPendingInvitationsForUser } from "@/server/invitations/claim-service";
import {
  CandidateProfileError,
  parseCandidateProfileInput,
  type CandidateProfileInput,
} from "@/server/candidate/candidate-profile-core";
import { insertCandidateProfileInTransaction } from "@/server/candidate/candidate-profile-service";
import {
  parseRecruiterVerificationInput,
  RecruiterVerificationError,
  type RecruiterVerificationInput,
} from "@/server/recruiter-verification/recruiter-verification-core";
import { createRecruiterVerificationSubmissionInTransaction } from "@/server/recruiter-verification/recruiter-verification-service";

const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 120;

// Splits the single `name` field into first/last name tokens
// for username generation. The first whitespace-delimited token is the first name;
// everything after it is the last name (may be empty for a single-word name).
const splitName = (name: string): { firstName: string; lastName: string } => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
};

// Signup role declaration. Exactly one of
// these two values is accepted on POST /api/v1/auth/register. The declared role determines:
//   1. The user-level `users.role` value persisted on the row.
//   2. Which of the two per-role verification timestamps is set at account-creation time.
//      The undeclared role's timestamp stays NULL.
// Server-side enforcement: a missing / unknown `as` value is rejected with 400; the client
// cannot fabricate the verified-role state.
export const SIGNUP_ROLE_VALUES = ["candidate", "recruiter"] as const;
export type SignupRole = (typeof SIGNUP_ROLE_VALUES)[number];

export const isSignupRole = (value: unknown): value is SignupRole => {
  return typeof value === "string" && (SIGNUP_ROLE_VALUES as readonly string[]).includes(value);
};

// Shared signup primitives, extracted so the Google-OAuth finalization path
// (`finalizeOAuthSignup` in oauth-account.ts) creates a users row through the SAME role/tier
// derivation and username generation as the credentials registration transaction, rather than
// duplicating the logic. Both call sites must agree byte-for-byte on:
//   - which per-role verification timestamp is set for a declared role, and
//   - that recruiter signup atomically grants the `minimal` tier,
//     keeping `users_recruiter_tier_consistency_chk` satisfied.

// The exact column set written to `users` for a declared signup role. The undeclared role's
// timestamp stays null; the DB CHECK `users_one_verified_role_chk` is satisfied because the
// declared role always sets one timestamp. Verification is sourced from the role DECLARATION, never
// from an OAuth provider's email_verified.
export const deriveSignupRoleColumns = (
  signupRole: SignupRole,
  now: Date,
): {
  role: SignupRole;
  candidateVerifiedAt: Date | null;
  recruiterVerifiedAt: Date | null;
  recruiterVerificationTier: "minimal" | "unverified";
} => ({
  role: signupRole,
  candidateVerifiedAt: signupRole === "candidate" ? now : null,
  recruiterVerifiedAt: signupRole === "recruiter" ? now : null,
  recruiterVerificationTier: signupRole === "recruiter" ? "minimal" : "unverified",
});

// Generates a unique, reserved-word-safe username from a display name, probing availability inside
// the caller's transaction. Wraps the username generator + name split so both signup paths share
// one implementation. Throws UsernameGenerationError if the bounded retry loop is exhausted; every
// caller translates that into a clean error.
export const generateUniqueUsernameForName = async (
  name: string,
  isAvailable: UsernameAvailabilityCheck,
): Promise<string> => {
  const { firstName, lastName } = splitName(name);
  return generateUsername({ firstName, lastName, isAvailable });
};

type AuthFlowErrorCode =
  | "invalid_payload"
  | "invalid_email"
  | "invalid_name"
  | "invalid_password"
  | "invalid_signup_role"
  | "email_exists"
  | "email_not_verified"
  | "verification_required"
  | "verification_code_invalid"
  | "verification_code_attempts_exceeded"
  | "verification_code_daily_limit"
  | "verification_unavailable"
  | "verification_email_failed"
  | "password_reset_token_invalid"
  | "password_reset_token_expired"
  | "password_not_set"
  | "invalid_current_password"
  | "username_generation_failed"
  | "candidate_profile_invalid_payload"
  | "candidate_profile_invalid_fields"
  | "candidate_profile_invalid_value"
  | "recruiter_verification_invalid_payload"
  | "recruiter_verification_invalid_value";

export class CredentialsAuthError extends Error {
  constructor(
    public readonly code: AuthFlowErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const normalizeEmail = (email: string): string => {
  return email.trim().toLowerCase();
};

const parseEmail = (email: unknown): string => {
  if (typeof email !== "string") {
    throw new CredentialsAuthError("invalid_email", 400, "Email must be a valid email address");
  }

  const normalized = normalizeEmail(email);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new CredentialsAuthError("invalid_email", 400, "Email must be a valid email address");
  }

  return normalized;
};

const parseName = (name: unknown): string => {
  if (typeof name !== "string") {
    throw new CredentialsAuthError(
      "invalid_name",
      400,
      `Name must be between ${NAME_MIN_LENGTH} and ${NAME_MAX_LENGTH} characters`,
    );
  }

  const normalized = name.trim();

  if (normalized.length < NAME_MIN_LENGTH || normalized.length > NAME_MAX_LENGTH) {
    throw new CredentialsAuthError(
      "invalid_name",
      400,
      `Name must be between ${NAME_MIN_LENGTH} and ${NAME_MAX_LENGTH} characters`,
    );
  }

  return normalized;
};

export const parsePassword = (password: unknown): string => {
  if (typeof password !== "string") {
    throw new CredentialsAuthError(
      "invalid_password",
      400,
      "Password must be between 8 and 72 characters",
    );
  }

  const normalized = password.trim();

  if (normalized.length < 8 || normalized.length > 72) {
    throw new CredentialsAuthError(
      "invalid_password",
      400,
      "Password must be between 8 and 72 characters",
    );
  }

  return normalized;
};

type RegistrationInput = {
  name: string;
  email: string;
  password: string;
  signupRole: SignupRole;
  // Present only for candidate signups. Candidate onboarding collects these descriptive fields in
  // the same request that creates the account, so the profile and the candidate verification grant
  // land in one transaction. Recruiter signups leave this null.
  candidateProfile: CandidateProfileInput | null;
  // Present only for recruiter signups. The affiliation form (full name, mobile number, optional
  // corporate email) creates a pending trust-verification submission in the same transaction as
  // the recruiter role grant. Candidate signups leave this null.
  recruiterVerification: RecruiterVerificationInput | null;
};

const parseSignupRole = (value: unknown): SignupRole => {
  if (!isSignupRole(value)) {
    throw new CredentialsAuthError(
      "invalid_signup_role",
      400,
      "Signup role declaration is required: use ?as=candidate or ?as=recruiter",
    );
  }

  return value;
};

export const parseRegistrationInput = (payload: unknown): RegistrationInput => {
  if (!isRecord(payload)) {
    throw new CredentialsAuthError(
      "invalid_payload",
      400,
      "Registration payload must be a JSON object",
    );
  }

  const signupRole = parseSignupRole(payload.signupRole ?? payload.role);

  // Candidate signups must carry a complete onboarding profile in the same payload. Candidate
  // validation failures are surfaced through the credentials-auth error pipeline (400) so the
  // register endpoint reports them uniformly.
  let candidateProfile: CandidateProfileInput | null = null;
  if (signupRole === "candidate") {
    try {
      candidateProfile = parseCandidateProfileInput(payload);
    } catch (error) {
      if (error instanceof CandidateProfileError) {
        throw new CredentialsAuthError(error.code, 400, error.message);
      }
      throw error;
    }
  }

  // Recruiter signups must carry the affiliation form in the same payload; validation failures
  // surface through the same 400 pipeline as candidate onboarding errors.
  let recruiterVerification: RecruiterVerificationInput | null = null;
  if (signupRole === "recruiter") {
    try {
      recruiterVerification = parseRecruiterVerificationInput(payload);
    } catch (error) {
      if (error instanceof RecruiterVerificationError) {
        // Parsing can only fail with the two validation codes; narrow explicitly for the union.
        const code =
          error.code === "recruiter_verification_invalid_payload"
            ? ("recruiter_verification_invalid_payload" as const)
            : ("recruiter_verification_invalid_value" as const);
        throw new CredentialsAuthError(code, 400, error.message);
      }
      throw error;
    }
  }

  return {
    name: parseName(payload.name),
    email: parseEmail(payload.email),
    password: parsePassword(payload.password),
    signupRole,
    candidateProfile,
    recruiterVerification,
  };
};

export const parseEmailPayload = (payload: unknown): { email: string } => {
  if (!isRecord(payload)) {
    throw new CredentialsAuthError("invalid_payload", 400, "Payload must be a JSON object");
  }

  return {
    email: parseEmail(payload.email),
  };
};

const replaceVerificationCodeForUser = async (
  userId: string,
  db: Database,
): Promise<{ code: string }> => {
  const code = issueRegistrationCode();

  await db
    .delete(userEmailVerificationTokens)
    .where(
      and(
        eq(userEmailVerificationTokens.userId, userId),
        isNull(userEmailVerificationTokens.consumedAt),
      ),
    );

  await db.insert(userEmailVerificationTokens).values({
    userId,
    tokenHash: hashRegistrationCode(userId, code),
    expiresAt: new Date(Date.now() + REGISTRATION_CODE_TTL_MS),
  });

  return { code };
};

// The sign-up and the code verification write the password the same way, and the verification's write replaces a password set before it.
const writePasswordHash = async (
  tx: Database,
  userId: string,
  passwordHash: string,
  now: Date,
): Promise<void> => {
  await tx
    .insert(userPasswordCredentials)
    .values({
      userId,
      passwordHash,
    })
    .onConflictDoUpdate({
      target: userPasswordCredentials.userId,
      set: {
        passwordHash,
        updatedAt: now,
      },
    });
};

const usernameIsFreeIn =
  (tx: Database): UsernameAvailabilityCheck =>
  async (candidate) => {
    const [taken] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate))
      .limit(1);
    return !taken;
  };

const usernameFailureError = (error: unknown, email: string): CredentialsAuthError | null => {
  // Username generation exhausted its bounded retry
  // loop. Recoverable: log and surface a clean 503 instead of a raw 500.
  if (error instanceof UsernameGenerationError) {
    logger.error("username.generation.exhausted", { email });
    return new CredentialsAuthError(
      "username_generation_failed",
      503,
      "Account could not be created right now. Please try again.",
    );
  }

  // The `users` table carries two unique
  // constraints reachable on INSERT: `email` and `users_username_unique_idx`.
  // A 23505 must be classified by constraint, otherwise a username collision
  // (e.g. the bounded generation loop loses a concurrent-registration race)
  // would be misreported to the client as `email_exists`. The constraint
  // name is exposed as `constraint_name` (postgres.js) or `constraint`
  // (node-postgres); `detail` is a final fallback.
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  ) {
    const pgError = error as { constraint_name?: string; constraint?: string; detail?: string };
    const constraint = pgError.constraint_name ?? pgError.constraint ?? "";
    const detail = pgError.detail ?? "";

    if (constraint.includes("username") || detail.includes("username")) {
      logger.error("username.generation.collision", { email });
      return new CredentialsAuthError(
        "username_generation_failed",
        503,
        "Account could not be created right now. Please try again.",
      );
    }
  }

  return null;
};

export const registerUserWithCredentials = async (
  payload: unknown,
  db: Database = getDb(),
): Promise<{
  email: string;
  verificationRequired: boolean;
  alreadyVerified: boolean;
}> => {
  const input = parseRegistrationInput(payload);
  const passwordHash = await hashPassword(input.password);

  try {
    const registrationState = await db.transaction(async (tx) => {
      const [existingUser] = await tx
        .select({
          id: users.id,
          emailVerified: users.emailVerified,
        })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);

      // Any existing account for this email refuses, verified or not, before any write: a second sign-up must never set the password, role or profile of an account its owner may still verify.
      if (existingUser) {
        throw existingUser.emailVerified
          ? new CredentialsAuthError(
              "email_exists",
              409,
              "An account with this email already exists",
            )
          : new CredentialsAuthError(
              "email_not_verified",
              409,
              "An unverified account with this email already exists",
            );
      }

      // Write the declared user-level role and the matching
      // *_verified_at timestamp at account-creation time. The CHECK constraint
      // `users_one_verified_role_chk` enforces the invariant at the DB layer; the application
      // also sets exactly one timestamp here so the constraint passes on the first INSERT.
      //
      // Recruiter signup auto-grants the `minimal` tier in the
      // same INSERT statement so tier and recruiterVerifiedAt land atomically. Candidate
      // signups leave the tier at the column default ('unverified'); the tier is only meaningful
      // once the account verifies the recruiter mode.
      const now = new Date();
      const roleColumns = deriveSignupRoleColumns(input.signupRole, now);

      // Generate a valid, unique, reserved-word-safe
      // username before the user INSERT. Generation runs inside this
      // transaction: the uniqueness probe sees only committed rows, and a
      // generation failure aborts the transaction so no user row is ever
      // persisted without a username.
      const username = await generateUniqueUsernameForName(input.name, usernameIsFreeIn(tx));

      const [inserted] = await tx
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          username,
          ...roleColumns,
        })
        .returning({ id: users.id });

      const userId = inserted?.id;

      if (!userId) {
        throw new Error("Failed to create user account");
      }

      await tx
        .insert(userProfiles)
        .values({
          userId,
          displayName: input.name,
        })
        .onConflictDoNothing();

      // Candidate onboarding profile is written in the SAME transaction that grants the candidate
      // verification timestamp (via roleColumns above), so a candidate account never exists without
      // its onboarding data. Recruiter signups skip this — recruiter onboarding is a separate flow.
      if (input.candidateProfile) {
        await insertCandidateProfileInTransaction(tx, userId, input.candidateProfile);
      }

      // Recruiter affiliation form lands in the SAME transaction as the recruiter role grant, so
      // every credentials-signup recruiter enters the review queue immediately. The account stays
      // sandboxed (tier `minimal`: drafts yes, publishing no) until platform ops approve.
      if (input.recruiterVerification) {
        await createRecruiterVerificationSubmissionInTransaction(
          tx,
          userId,
          input.recruiterVerification,
        );
      }

      await writePasswordHash(tx, userId, passwordHash, now);

      const issuedCode = await replaceVerificationCodeForUser(userId, tx);

      return {
        userId,
        verificationCode: issuedCode.code,
      };
    });

    if (registrationState.verificationCode) {
      try {
        await sendRegistrationVerificationEmail({
          email: input.email,
          code: registrationState.verificationCode,
        });
      } catch (error) {
        // The cause never reaches the caller — the response is a generic 503 so it cannot leak
        // provider detail — so it has to be logged here or it is lost. A quota rejection, a
        // revoked key, an unverified sender domain and a network failure are otherwise
        // indistinguishable from the outside.
        logger.error("auth.verification_email.dispatch_failed", {
          email: input.email,
          reason: error instanceof Error ? error.message : String(error),
        });

        throw new CredentialsAuthError(
          "verification_email_failed",
          503,
          "Account created but verification email could not be sent yet",
        );
      }
    }

    return {
      email: input.email,
      verificationRequired: true,
      alreadyVerified: false,
    };
  } catch (error) {
    if (error instanceof CredentialsAuthError) {
      throw error;
    }

    const usernameError = usernameFailureError(error, input.email);

    if (usernameError) {
      throw usernameError;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new CredentialsAuthError(
        "email_exists",
        409,
        "An account with this email already exists",
      );
    }

    throw error;
  }
};

export const resendRegistrationVerification = async (
  payload: unknown,
  db: Database = getDb(),
): Promise<{ email: string }> => {
  const { email } = parseEmailPayload(payload);

  const [userRecord] = await db
    .select({
      id: users.id,
      name: users.name,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!userRecord) {
    throw new CredentialsAuthError("verification_required", 404, "Registration record not found");
  }

  if (userRecord.emailVerified) {
    throw new CredentialsAuthError(
      "email_exists",
      409,
      "Email already verified. Please login with your password",
    );
  }

  const [credentialRecord] = await db
    .select({
      userId: userPasswordCredentials.userId,
    })
    .from(userPasswordCredentials)
    .where(eq(userPasswordCredentials.userId, userRecord.id))
    .limit(1);

  if (!credentialRecord) {
    throw new CredentialsAuthError("verification_required", 404, "Registration record not found");
  }

  const issuedCode = await replaceVerificationCodeForUser(userRecord.id, db);

  try {
    await sendRegistrationVerificationEmail({
      email,
      code: issuedCode.code,
    });
  } catch (error) {
    logger.error("auth.verification_email.dispatch_failed", {
      email,
      reason: error instanceof Error ? error.message : String(error),
    });

    throw new CredentialsAuthError(
      "verification_email_failed",
      503,
      "Verification email could not be sent",
    );
  }

  return {
    email,
  };
};

const VERIFICATION_CODE_PATTERN = /^[0-9]{6}$/;

const invalidVerificationCodeError = (): CredentialsAuthError =>
  new CredentialsAuthError(
    "verification_code_invalid",
    400,
    "Kode verifikasi salah atau sudah tidak berlaku.",
  );

const codeAttemptsExceededError = (): CredentialsAuthError =>
  new CredentialsAuthError(
    "verification_code_attempts_exceeded",
    429,
    "Terlalu banyak percobaan kode yang salah.",
  );

const dailyCodeLimitError = (): CredentialsAuthError =>
  new CredentialsAuthError(
    "verification_code_daily_limit",
    429,
    "Terlalu banyak percobaan kode yang salah untuk email ini.",
  );

const emailAlreadyVerifiedError = (): CredentialsAuthError =>
  new CredentialsAuthError(
    "email_exists",
    409,
    "Email already verified. Please login with your password",
  );

const parseVerificationCodePayload = (payload: unknown): RegistrationInput & { code: string } => {
  if (!isRecord(payload)) {
    throw new CredentialsAuthError("invalid_payload", 400, "Payload must be a JSON object");
  }

  const code = typeof payload.code === "string" ? payload.code.trim() : "";

  if (!VERIFICATION_CODE_PATTERN.test(code)) {
    throw invalidVerificationCodeError();
  }

  return { ...parseRegistrationInput(payload), code };
};

// Fail-closed: a limiter that cannot count refuses, because an uncounted guess is an unlimited one.
const countCodeAttemptOrRefuse = async (
  key: string,
  policy: { limit: number; windowSeconds: number },
  throttledError: () => CredentialsAuthError,
): Promise<void> => {
  const outcome = await checkFixedWindowLimitFailClosed({
    key,
    limit: policy.limit,
    windowSeconds: policy.windowSeconds,
  });

  if (outcome.decision === "throttled") {
    throw throttledError();
  }

  if (outcome.decision === "unavailable") {
    throw new CredentialsAuthError(
      "verification_unavailable",
      503,
      "Verifikasi sedang tidak tersedia.",
    );
  }
};

const findLiveVerificationCode = async (
  userId: string,
  db: Database,
): Promise<{ id: string; tokenHash: string } | undefined> => {
  const [codeRow] = await db
    .select({
      id: userEmailVerificationTokens.id,
      tokenHash: userEmailVerificationTokens.tokenHash,
    })
    .from(userEmailVerificationTokens)
    .where(
      and(
        eq(userEmailVerificationTokens.userId, userId),
        isNull(userEmailVerificationTokens.consumedAt),
        gt(userEmailVerificationTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(userEmailVerificationTokens.createdAt))
    .limit(1);

  return codeRow;
};

// The person who typed the code defines the account, so nothing an earlier sign-up for this address wrote survives verification.
const replaceSignupDetailsWithVerifiers = async (
  tx: Database,
  userId: string,
  details: RegistrationInput,
  now: Date,
): Promise<void> => {
  const [stored] = await tx
    .select({
      name: users.name,
      username: users.username,
      recruiterVerificationTier: users.recruiterVerificationTier,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const username =
    stored && stored.name === details.name
      ? stored.username
      : await generateUniqueUsernameForName(details.name, usernameIsFreeIn(tx));
  const { recruiterVerificationTier: declaredTier, ...declaredRoleColumns } =
    deriveSignupRoleColumns(details.signupRole, now);
  const tierRises = !stored || !meetsRecruiterTier(stored.recruiterVerificationTier, declaredTier);

  // The tier only rises here: users_recruiter_tier_no_downgrade refuses a lower value, and "minimal" grants nothing without recruiterVerifiedAt.
  await tx
    .update(users)
    .set({
      name: details.name,
      username,
      ...declaredRoleColumns,
      ...(tierRises ? { recruiterVerificationTier: declaredTier } : {}),
      updatedAt: now,
    })
    .where(eq(users.id, userId));

  await tx
    .insert(userProfiles)
    .values({ userId, displayName: details.name })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: { displayName: details.name },
    });

  await tx.delete(candidateProfiles).where(eq(candidateProfiles.userId, userId));

  if (details.candidateProfile) {
    await insertCandidateProfileInTransaction(tx, userId, details.candidateProfile);
  }

  await tx
    .delete(recruiterVerificationSubmissions)
    .where(eq(recruiterVerificationSubmissions.userId, userId));

  if (details.recruiterVerification) {
    await createRecruiterVerificationSubmissionInTransaction(
      tx,
      userId,
      details.recruiterVerification,
    );
  }
};

const completeCodeVerification = async (
  tx: Database,
  user: { id: string; email: string },
  codeRowId: string,
  passwordHash: string,
  details: RegistrationInput,
): Promise<void> => {
  const now = new Date();

  const [consumed] = await tx
    .update(userEmailVerificationTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(userEmailVerificationTokens.id, codeRowId),
        isNull(userEmailVerificationTokens.consumedAt),
      ),
    )
    .returning({ id: userEmailVerificationTokens.id });

  if (!consumed) {
    throw invalidVerificationCodeError();
  }

  const [verified] = await tx
    .update(users)
    .set({ emailVerified: now, sessionsInvalidBefore: now, updatedAt: now })
    .where(and(eq(users.id, user.id), isNull(users.emailVerified)))
    .returning({ id: users.id });

  if (!verified) {
    throw emailAlreadyVerifiedError();
  }

  await writePasswordHash(tx, user.id, passwordHash, now);
  await replaceSignupDetailsWithVerifiers(tx, user.id, details, now);

  await tx
    .delete(userEmailVerificationTokens)
    .where(
      and(
        eq(userEmailVerificationTokens.userId, user.id),
        ne(userEmailVerificationTokens.id, codeRowId),
      ),
    );

  // Claim-at-signup. Attach every `pending_claim` invitation addressed to this email
  // (target_user_id IS NULL) across both invitation systems and flip them to `pending`. Runs in
  // the SAME transaction as the verification flip so a half-claimed state cannot occur. Claim
  // fires only after the code proved the inbox and the password became the code-typer's.
  await claimPendingInvitationsForUser(user.id, user.email, tx, now);
};

// The code proves the person holds the inbox, and the password sent with it becomes the account's
// password, so a password a stranger set before verification never survives verification. The
// details sent with the code replace whatever an earlier sign-up wrote.
export const verifyEmailCodeAndSetPassword = async (
  payload: unknown,
  db: Database = getDb(),
): Promise<{ email: string }> => {
  const input = parseVerificationCodePayload(payload);

  const [user] = await db
    .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  if (!user) {
    throw invalidVerificationCodeError();
  }

  if (user.emailVerified) {
    throw emailAlreadyVerifiedError();
  }

  await countCodeAttemptOrRefuse(
    `${REGISTRATION_CODE_DAILY_LIMIT.keyPrefix}${user.id}`,
    REGISTRATION_CODE_DAILY_LIMIT,
    dailyCodeLimitError,
  );

  const codeRow = await findLiveVerificationCode(user.id, db);

  if (!codeRow) {
    throw invalidVerificationCodeError();
  }

  await countCodeAttemptOrRefuse(
    `${REGISTRATION_CODE_ATTEMPT_LIMIT.keyPrefix}${codeRow.id}`,
    REGISTRATION_CODE_ATTEMPT_LIMIT,
    codeAttemptsExceededError,
  );

  if (!registrationCodeMatches(codeRow.tokenHash, user.id, input.code)) {
    throw invalidVerificationCodeError();
  }

  const passwordHash = await hashPassword(input.password);

  try {
    await db.transaction((tx) =>
      completeCodeVerification(tx, user, codeRow.id, passwordHash, input),
    );
  } catch (error) {
    const usernameError = usernameFailureError(error, user.email);

    if (usernameError) {
      throw usernameError;
    }

    throw error;
  }

  return { email: user.email };
};

// Method-first credentials entry. The single `/auth/login` page asks for email +
// password, then must branch existing-vs-new BEFORE deciding whether to attempt a password
// sign-in, show an "email not verified" notice, or offer the role picker. Credentials is
// email-first (unlike OAuth, where the provider resolves identity), so we classify by email:
//   - `none`       — no account; the page offers the role picker (signup).
//   - `unverified` — an account exists but email is not yet verified; the page shows the
//                    verify notice, collects the sign-up details and sends a code through
//                    resend. Register refuses it; the details travel with the code instead.
//   - `verified`   — an account exists and is verified (incl. a Google-only account, which has
//                    emailVerified set but no password); the page attempts the password sign-in,
//                    where a wrong/absent password collapses to the generic invalid-credentials
//                    response (no Google hint — design-pass only).
//
// Enumeration note (flagged for security review): branching existing-vs-new inherently reveals
// whether an email has an account — this is intrinsic to the owner-approved method-first UX. It
// exposes nothing the existing register endpoint does not already leak (register returns 409
// `email_exists` for a taken, verified email).
//
// Rate limiting for THIS function is applied by its route (POST /api/v1/auth/identify), before the
// classification runs. That is a statement about this classifier only, not about the file: the
// registration and resend paths this module also exports are limited by their own routes, with
// their own keys and ceilings, and none of the three shares a bucket with another.
export type EmailLoginState = "none" | "unverified" | "verified";

export const classifyEmailForLogin = async (
  emailInput: unknown,
  db: Database = getDb(),
): Promise<{ state: EmailLoginState }> => {
  const email = parseEmail(emailInput);

  const [row] = await db
    .select({ id: users.id, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!row) {
    return { state: "none" };
  }

  return { state: row.emailVerified ? "verified" : "unverified" };
};

export const authenticateWithEmailPassword = async (
  email: string,
  password: string,
  db: Database = getDb(),
): Promise<
  | {
      status: "authenticated";
      user: {
        id: string;
        email: string;
        role: (typeof users.$inferSelect)["role"];
      };
    }
  | { status: "email_not_verified" }
  | { status: "account_suspended" }
  | { status: "invalid_credentials" }
> => {
  const normalizedEmail = parseEmail(email);
  const normalizedPassword = parsePassword(password);

  const [userRecord] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      emailVerified: users.emailVerified,
      // Suspension is read from this same row used for password verification. No
      // independent suspension query is issued at authorize time, so there is no separate lookup
      // that could fail and force a fail-open/fail-closed decision here.
      suspendedAt: users.suspendedAt,
      passwordHash: userPasswordCredentials.passwordHash,
    })
    .from(users)
    .leftJoin(userPasswordCredentials, eq(userPasswordCredentials.userId, users.id))
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (!userRecord?.passwordHash) {
    return {
      status: "invalid_credentials",
    };
  }

  const verified = await verifyPassword(normalizedPassword, userRecord.passwordHash);

  if (!verified) {
    return {
      status: "invalid_credentials",
    };
  }

  // Login-time suspension block (the server-side guarantee point). This is evaluated
  // only AFTER the password is confirmed correct: a wrong password for a suspended account falls
  // through the `!verified` branch above and returns the generic `invalid_credentials`, so the
  // suspended signal is never observable to anyone who did not supply the correct password
  // (account-enumeration safety). A non-null `suspended_at` aborts the login before any user
  // object is returned to authorize, so no JWT/session is ever issued. platform_ops accounts are
  // protected from suspension at the service layer, so their `suspended_at` is always
  // null and this uniform check passes them without role special-casing. The existing per-request
  // `account_suspended` 403 in assertAuthenticatedSession remains as defense in depth.
  if (userRecord.suspendedAt) {
    return {
      status: "account_suspended",
    };
  }

  if (!userRecord.emailVerified) {
    return {
      status: "email_not_verified",
    };
  }

  return {
    status: "authenticated",
    user: {
      id: userRecord.id,
      email: userRecord.email,
      role: userRecord.role,
    },
  };
};
