import { and, eq, isNull, lt, ne } from "drizzle-orm";
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

const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 120;
const REGISTRATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

type AuthFlowErrorCode =
  | "invalid_payload"
  | "invalid_email"
  | "invalid_name"
  | "invalid_password"
  | "email_exists"
  | "verification_required"
  | "verification_token_invalid"
  | "verification_token_expired"
  | "verification_email_failed";

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

      if (existingUser?.emailVerified) {
        const [existingCredential] = await tx
          .select({ userId: userPasswordCredentials.userId })
          .from(userPasswordCredentials)
          .where(eq(userPasswordCredentials.userId, existingUser.id))
          .limit(1);

        if (existingCredential) {
          throw new CredentialsAuthError(
            "email_exists",
            409,
            "An account with this email already exists",
          );
        }
      }

      const userId =
        existingUser?.id ??
        (
          await tx
            .insert(users)
            .values({
              email: input.email,
              name: input.name,
            })
            .returning({ id: users.id })
        )[0]?.id;

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
  });

  return {
    email: tokenRecord.email,
    status: "verified",
  };
};

export const clearExpiredVerificationTokens = async (db: Database = getDb()): Promise<void> => {
  await db
    .delete(userEmailVerificationTokens)
    .where(
      and(
        lt(userEmailVerificationTokens.expiresAt, new Date()),
        isNull(userEmailVerificationTokens.consumedAt),
      ),
    );
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
