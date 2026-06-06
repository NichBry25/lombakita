import { and, eq, isNull, ne } from "drizzle-orm";
import { logger } from "@/lib/logger";
import {
  generateUsername,
  type UsernameAvailabilityCheck,
  UsernameGenerationError,
} from "@/lib/username/generate";
import { getDb, type Database } from "@/server/db/client";
import {
  userEmailVerificationTokens,
  userPasswordCredentials,
  userProfiles,
  users,
} from "@/server/db/schema";
import {
  hashPassword,
  hashVerificationToken,
  issueVerificationToken,
  verifyPassword,
} from "@/server/auth/password";
import { sendRegistrationVerificationEmail } from "@/server/auth/email-verification";
import { claimPendingInvitationsForUser } from "@/server/invitations/claim-service";

const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 120;
const REGISTRATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// Step 2.1a / DEC-0054 — split the single `name` field into first/last name tokens
// for username generation. The first whitespace-delimited token is the first name;
// everything after it is the last name (may be empty for a single-word name).
const splitName = (name: string): { firstName: string; lastName: string } => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
};

// Rollback Step 1.3 — CCR-03 / DEC-0037 / DEC-0058: signup role declaration. Exactly one of
// these two values is accepted on POST /api/v1/auth/register. The declared role determines:
//   1. The user-level `users.role` value persisted on the row.
//   2. Which of the two per-role verification timestamps is set at account-creation time
//      (CCR-02 / DEC-0036). The undeclared role's timestamp stays NULL.
// Server-side enforcement: a missing / unknown `as` value is rejected with 400; the client
// cannot fabricate the verified-role state.
export const SIGNUP_ROLE_VALUES = ["candidate", "recruiter"] as const;
export type SignupRole = (typeof SIGNUP_ROLE_VALUES)[number];

export const isSignupRole = (value: unknown): value is SignupRole => {
  return typeof value === "string" && (SIGNUP_ROLE_VALUES as readonly string[]).includes(value);
};

// Step 6.5d — shared signup primitives, extracted so the Google-OAuth finalization path
// (`finalizeOAuthSignup` in oauth-account.ts) creates a users row through the SAME role/tier
// derivation and username generation as the credentials registration transaction, rather than
// duplicating the logic. Both call sites must agree byte-for-byte on:
//   - which per-role verification timestamp is set for a declared role, and
//   - that recruiter signup atomically grants the `minimal` tier (Step 4.0c / DEC-0053),
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
// the caller's transaction. Wraps the Step 2.1a generator + name split so both signup paths share
// one implementation. Throws UsernameGenerationError if the bounded retry loop is exhausted; both
// callers translate that into a clean 503.
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
  | "verification_required"
  | "verification_token_invalid"
  | "verification_token_expired"
  | "verification_email_failed"
  | "username_generation_failed";

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

const parsePassword = (password: unknown): string => {
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

  return {
    name: parseName(payload.name),
    email: parseEmail(payload.email),
    password: parsePassword(payload.password),
    signupRole: parseSignupRole(payload.signupRole ?? payload.role),
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

const parseVerificationToken = (token: unknown): string => {
  if (typeof token !== "string") {
    throw new CredentialsAuthError(
      "verification_token_invalid",
      400,
      "Verification token is invalid",
    );
  }

  const normalized = token.trim();

  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new CredentialsAuthError(
      "verification_token_invalid",
      400,
      "Verification token is invalid",
    );
  }

  return normalized;
};

const createVerificationChallengeForUser = async (
  userId: string,
  db: Database,
): Promise<{ rawToken: string; expiresAt: Date }> => {
  const issued = issueVerificationToken();
  const expiresAt = new Date(Date.now() + REGISTRATION_TOKEN_TTL_MS);

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
    tokenHash: issued.tokenHash,
    expiresAt,
  });

  return {
    rawToken: issued.rawToken,
    expiresAt,
  };
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

      // Step 6.5d.1 (M1) — duplicate-account guard. This fires for ANY verified account, whether
      // it authenticates by password OR by a linked OAuth identity. Google-only accounts (Step
      // 6.5d) have `emailVerified` set but NO `user_password_credentials` row; the prior guard only
      // threw when a password row existed, so a Google-only account fell through and this PUBLIC
      // endpoint would write an attacker-supplied password (and re-apply an attacker-declared role)
      // onto it — a silent, unauthenticated account takeover. A verified account is already a real
      // identity; re-registration over it via this public endpoint is never legitimate (adding a
      // password to an OAuth account belongs in a separate authenticated flow, not here). The throw
      // occurs BEFORE any mutation below (username INSERT, role-flip UPDATE, password upsert), so no
      // write lands. The unverified re-registration path is unaffected — this guard keys on
      // `emailVerified`, and a verified row always pre-exists, so there is no create-race window:
      // a concurrent same-email creation collapses to the 23505 → `email_exists` branch below, and
      // the role-flip UPDATE / password upsert only ever target an unverified-existing or brand-new
      // row (never a verified one, which threw here).
      if (existingUser?.emailVerified) {
        throw new CredentialsAuthError(
          "email_exists",
          409,
          "An account with this email already exists",
        );
      }

      // Rollback Step 1.3 — write the declared user-level role and the matching
      // *_verified_at timestamp at account-creation time. The CHECK constraint
      // `users_one_verified_role_chk` enforces the invariant at the DB layer; the application
      // also sets exactly one timestamp here so the constraint passes on the first INSERT.
      // For pre-existing unverified rows (re-registration into the same email without prior
      // email verification) we re-apply the declared role + verifiedAt to reflect the latest
      // declaration.
      //
      // Step 4.0c (CCR-19 / DEC-0053) — recruiter signup auto-grants the `minimal` tier in the
      // same INSERT/UPDATE statement so tier and recruiterVerifiedAt land atomically. Candidate
      // signups leave the tier at the column default ('unverified'); the tier is only meaningful
      // once the account verifies the recruiter mode.
      const now = new Date();
      const roleColumns = deriveSignupRoleColumns(input.signupRole, now);

      let userId = existingUser?.id;

      if (!userId) {
        // Step 2.1a / DEC-0054 — generate a valid, unique, reserved-word-safe
        // username before the user INSERT. Generation runs inside this
        // transaction: the uniqueness probe sees only committed rows, and a
        // generation failure aborts the transaction so no user row is ever
        // persisted without a username.
        const username = await generateUniqueUsernameForName(input.name, async (candidate) => {
          const [taken] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.username, candidate))
            .limit(1);
          return !taken;
        });

        const [inserted] = await tx
          .insert(users)
          .values({
            email: input.email,
            name: input.name,
            username,
            ...roleColumns,
          })
          .returning({ id: users.id });

        userId = inserted?.id;
      }

      if (!userId) {
        throw new Error("Failed to create user account");
      }

      if (existingUser?.id) {
        // Re-declaration on an unverified pre-existing account: re-apply the role declaration
        // and verification timestamp so the row reflects the latest signup intent. The CHECK
        // invariant always holds (at least one of the two timestamps is non-null on every
        // path).
        await tx
          .update(users)
          .set({
            ...roleColumns,
            updatedAt: now,
          })
          .where(eq(users.id, userId));
      }

      await tx
        .insert(userProfiles)
        .values({
          userId,
          displayName: input.name,
        })
        .onConflictDoNothing();

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
            updatedAt: new Date(),
          },
        });

      if (existingUser?.emailVerified) {
        return {
          userId,
          alreadyVerified: true,
          verificationRawToken: null as string | null,
        };
      }

      const verificationChallenge = await createVerificationChallengeForUser(userId, tx);

      return {
        userId,
        alreadyVerified: false,
        verificationRawToken: verificationChallenge.rawToken,
      };
    });

    if (!registrationState.alreadyVerified && registrationState.verificationRawToken) {
      try {
        await sendRegistrationVerificationEmail({
          email: input.email,
          name: input.name,
          rawToken: registrationState.verificationRawToken,
        });
      } catch {
        throw new CredentialsAuthError(
          "verification_email_failed",
          503,
          "Account created but verification email could not be sent yet",
        );
      }
    }

    return {
      email: input.email,
      verificationRequired: !registrationState.alreadyVerified,
      alreadyVerified: registrationState.alreadyVerified,
    };
  } catch (error) {
    if (error instanceof CredentialsAuthError) {
      throw error;
    }

    // Step 2.1a / DEC-0054 — username generation exhausted its bounded retry
    // loop. Recoverable: log and surface a clean 503 instead of a raw 500.
    if (error instanceof UsernameGenerationError) {
      logger.error("username.generation.exhausted", { email: input.email });
      throw new CredentialsAuthError(
        "username_generation_failed",
        503,
        "Account could not be created right now. Please try again.",
      );
    }

    // Step 2.1a / DEC-0054 — the `users` table now carries two unique
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
        logger.error("username.generation.collision", { email: input.email });
        throw new CredentialsAuthError(
          "username_generation_failed",
          503,
          "Account could not be created right now. Please try again.",
        );
      }

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

  const challenge = await createVerificationChallengeForUser(userRecord.id, db);

  try {
    await sendRegistrationVerificationEmail({
      email,
      name: userRecord.name ?? "Pengguna Lombakita",
      rawToken: challenge.rawToken,
    });
  } catch {
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

export const verifyRegistrationEmailToken = async (
  token: unknown,
  db: Database = getDb(),
): Promise<{ email: string; status: "verified" | "already_verified" }> => {
  const rawToken = parseVerificationToken(token);
  const tokenHash = hashVerificationToken(rawToken);

  const [tokenRecord] = await db
    .select({
      id: userEmailVerificationTokens.id,
      userId: userEmailVerificationTokens.userId,
      expiresAt: userEmailVerificationTokens.expiresAt,
      consumedAt: userEmailVerificationTokens.consumedAt,
      email: users.email,
      emailVerified: users.emailVerified,
    })
    .from(userEmailVerificationTokens)
    .innerJoin(users, eq(users.id, userEmailVerificationTokens.userId))
    .where(eq(userEmailVerificationTokens.tokenHash, tokenHash))
    .limit(1);

  if (!tokenRecord) {
    throw new CredentialsAuthError(
      "verification_token_invalid",
      400,
      "Verification token is invalid",
    );
  }

  if (tokenRecord.consumedAt) {
    return {
      email: tokenRecord.email,
      status: tokenRecord.emailVerified ? "already_verified" : "verified",
    };
  }

  if (tokenRecord.expiresAt.getTime() < Date.now()) {
    throw new CredentialsAuthError(
      "verification_token_expired",
      400,
      "Verification token is expired",
    );
  }

  if (tokenRecord.emailVerified) {
    await db
      .update(userEmailVerificationTokens)
      .set({
        consumedAt: new Date(),
      })
      .where(eq(userEmailVerificationTokens.id, tokenRecord.id));

    return {
      email: tokenRecord.email,
      status: "already_verified",
    };
  }

  await db.transaction(async (tx) => {
    const now = new Date();

    await tx
      .update(users)
      .set({
        emailVerified: now,
        updatedAt: now,
      })
      .where(eq(users.id, tokenRecord.userId));

    await tx
      .update(userEmailVerificationTokens)
      .set({
        consumedAt: now,
      })
      .where(eq(userEmailVerificationTokens.id, tokenRecord.id));

    await tx
      .delete(userEmailVerificationTokens)
      .where(
        and(
          eq(userEmailVerificationTokens.userId, tokenRecord.userId),
          ne(userEmailVerificationTokens.id, tokenRecord.id),
        ),
      );

    // Step 6.5e — claim-at-signup. Now that this account's email is verified, attach every
    // `pending_claim` invitation addressed to it (target_user_id IS NULL) across both invitation
    // systems and flip them to `pending`. Runs in the SAME transaction as the verification flip so a
    // half-claimed state cannot occur. Claim fires ONLY on verified-email match — an unverified
    // signup never reaches here.
    await claimPendingInvitationsForUser(tokenRecord.userId, tokenRecord.email, tx, now);
  });

  return {
    email: tokenRecord.email,
    status: "verified",
  };
};

// Step 6.5d.1 — method-first credentials entry. The single `/auth/login` page asks for email +
// password, then must branch existing-vs-new BEFORE deciding whether to attempt a password
// sign-in, show an "email not verified" notice, or offer the role picker. Credentials is
// email-first (unlike OAuth, where the provider resolves identity), so we classify by email:
//   - `none`       — no account; the page offers the role picker (signup).
//   - `unverified` — an account exists but email is not yet verified; the page shows the
//                    verify notice + resend, and must NOT offer signup (insert would hit 23505).
//   - `verified`   — an account exists and is verified (incl. a Google-only account, which has
//                    emailVerified set but no password); the page attempts the password sign-in,
//                    where a wrong/absent password collapses to the generic invalid-credentials
//                    response (no Google hint — design-pass only).
//
// Enumeration note (flagged for security review): branching existing-vs-new inherently reveals
// whether an email has an account — this is intrinsic to the owner-approved method-first UX. It
// exposes nothing the existing register endpoint does not already leak (register returns 409
// `email_exists` for a taken, verified email). Server-side rate-limiting is a future hardening
// item (6.5d.1 debt), not added here.
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
      // Step 6.5c — suspension is read from this same row used for password verification. No
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

  // Step 6.5c — login-time suspension block (the server-side guarantee point). This is evaluated
  // only AFTER the password is confirmed correct: a wrong password for a suspended account falls
  // through the `!verified` branch above and returns the generic `invalid_credentials`, so the
  // suspended signal is never observable to anyone who did not supply the correct password
  // (account-enumeration safety). A non-null `suspended_at` aborts the login before any user
  // object is returned to authorize, so no JWT/session is ever issued. platform_ops accounts are
  // protected from suspension at the service layer (Step 6.2), so their `suspended_at` is always
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
