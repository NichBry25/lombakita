import { and, eq, isNull, ne } from "drizzle-orm";
import { CredentialsAuthError, parsePassword } from "@/server/auth/credentials-auth";
import {
  hashPassword,
  hashVerificationToken,
  issueVerificationToken,
  verifyPassword,
} from "@/server/auth/password";
import { PASSWORD_CHANGE_FAILED_ATTEMPT_LIMIT } from "@/server/auth/rate-limit-constants";
import { getDb, type Database } from "@/server/db/client";
import { userPasswordCredentials, userPasswordResetTokens, users } from "@/server/db/schema";
import {
  checkFailedAttemptLimitFailClosed,
  clearFailedAttempts,
  recordFailedAttemptFailClosed,
} from "@/server/redis/rate-limit";

export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

const FALLBACK_DISPLAY_NAME = "Pengguna Lombakita";

type AccountEligibility = {
  status: (typeof users.$inferSelect)["status"];
  suspendedAt: Date | null;
  emailVerified: Date | null;
};

// The population a reset may act on. Anyone else is indistinguishable from an unknown address at
// the request route, and a token issued before the account left this population stops working.
const isEligibleForPasswordReset = (account: AccountEligibility): boolean =>
  account.status === "active" && account.suspendedAt === null && account.emailVerified !== null;

const invalidResetTokenError = (): CredentialsAuthError =>
  new CredentialsAuthError("password_reset_token_invalid", 400, "Tautan atur ulang tidak valid");

const parseResetConfirmPayload = (payload: unknown): { token: string; password: unknown } => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CredentialsAuthError("invalid_payload", 400, "Payload must be a JSON object");
  }

  const { token, password } = payload as Record<string, unknown>;
  const tokenShapeIsValid = typeof token === "string" && /^[a-f0-9]{64}$/i.test(token.trim());
  if (!tokenShapeIsValid) {
    throw invalidResetTokenError();
  }

  return { token: token.trim(), password };
};

export const accountHasPassword = async (
  userId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const [credential] = await db
    .select({ userId: userPasswordCredentials.userId })
    .from(userPasswordCredentials)
    .where(eq(userPasswordCredentials.userId, userId))
    .limit(1);

  return credential !== undefined;
};

export type PasswordResetRequestOutcome =
  | { action: "none" }
  | { action: "send_reset"; userId: string; email: string; name: string; rawToken: string }
  | { action: "send_google_notice"; userId: string; email: string; name: string };

const issuePasswordResetToken = async (userId: string, db: Database): Promise<string> => {
  const issued = issueVerificationToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);

  await db.transaction(async (tx) => {
    await tx
      .delete(userPasswordResetTokens)
      .where(
        and(eq(userPasswordResetTokens.userId, userId), isNull(userPasswordResetTokens.consumedAt)),
      );

    await tx.insert(userPasswordResetTokens).values({
      userId,
      tokenHash: issued.tokenHash,
      expiresAt,
    });
  });

  return issued.rawToken;
};

/**
 * Decides what a reset request should send, and issues the token when it should send one.
 *
 * The caller answers the visitor identically for every outcome; this function only decides what is
 * mailed, never what is said.
 */
export const requestPasswordReset = async (
  email: string,
  db: Database = getDb(),
): Promise<PasswordResetRequestOutcome> => {
  const [account] = await db
    .select({
      id: users.id,
      name: users.name,
      status: users.status,
      suspendedAt: users.suspendedAt,
      emailVerified: users.emailVerified,
      passwordUserId: userPasswordCredentials.userId,
    })
    .from(users)
    .leftJoin(userPasswordCredentials, eq(userPasswordCredentials.userId, users.id))
    .where(eq(users.email, email))
    .limit(1);

  if (!account || !isEligibleForPasswordReset(account)) {
    return { action: "none" };
  }

  const name = account.name ?? FALLBACK_DISPLAY_NAME;

  if (!account.passwordUserId) {
    return { action: "send_google_notice", userId: account.id, email, name };
  }

  const rawToken = await issuePasswordResetToken(account.id, db);

  return { action: "send_reset", userId: account.id, email, name, rawToken };
};

/**
 * Sets a new password from a reset link, then signs the account out everywhere.
 *
 * THE ORDER IS LOAD-BEARING: the token is looked up and judged BEFORE the password is hashed, so a
 * guessed or replayed token costs no scrypt work.
 */
export const confirmPasswordReset = async (
  payload: unknown,
  db: Database = getDb(),
): Promise<{ userId: string; email: string; name: string }> => {
  const { token, password } = parseResetConfirmPayload(payload);
  const tokenHash = hashVerificationToken(token);

  const [tokenRecord] = await db
    .select({
      id: userPasswordResetTokens.id,
      userId: userPasswordResetTokens.userId,
      expiresAt: userPasswordResetTokens.expiresAt,
      consumedAt: userPasswordResetTokens.consumedAt,
      email: users.email,
      name: users.name,
      status: users.status,
      suspendedAt: users.suspendedAt,
      emailVerified: users.emailVerified,
      passwordUserId: userPasswordCredentials.userId,
    })
    .from(userPasswordResetTokens)
    .innerJoin(users, eq(users.id, userPasswordResetTokens.userId))
    .leftJoin(userPasswordCredentials, eq(userPasswordCredentials.userId, users.id))
    .where(eq(userPasswordResetTokens.tokenHash, tokenHash))
    .limit(1);

  if (!tokenRecord || tokenRecord.consumedAt) {
    throw invalidResetTokenError();
  }

  if (tokenRecord.expiresAt.getTime() < Date.now()) {
    throw new CredentialsAuthError(
      "password_reset_token_expired",
      400,
      "Tautan atur ulang sudah kedaluwarsa",
    );
  }

  if (!isEligibleForPasswordReset(tokenRecord) || !tokenRecord.passwordUserId) {
    throw invalidResetTokenError();
  }

  const validPassword = parsePassword(password);
  const passwordHash = await hashPassword(validPassword);

  await db.transaction(async (tx) => {
    const now = new Date();

    const consumed = await tx
      .update(userPasswordResetTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(userPasswordResetTokens.id, tokenRecord.id),
          isNull(userPasswordResetTokens.consumedAt),
        ),
      )
      .returning({ id: userPasswordResetTokens.id });

    if (consumed.length === 0) {
      throw invalidResetTokenError();
    }

    await tx
      .update(userPasswordCredentials)
      .set({ passwordHash, updatedAt: now })
      .where(eq(userPasswordCredentials.userId, tokenRecord.userId));

    await tx
      .update(users)
      .set({ sessionsInvalidBefore: now, updatedAt: now })
      .where(eq(users.id, tokenRecord.userId));

    await tx
      .delete(userPasswordResetTokens)
      .where(
        and(
          eq(userPasswordResetTokens.userId, tokenRecord.userId),
          ne(userPasswordResetTokens.id, tokenRecord.id),
        ),
      );
  });

  return {
    userId: tokenRecord.userId,
    email: tokenRecord.email,
    name: tokenRecord.name ?? FALLBACK_DISPLAY_NAME,
  };
};

// Same trim and length check as sign-in (parsePassword). The stored hash is of the trimmed password,
// and a wrong-length one can never match, so it is refused before any scrypt work and is not counted
// toward the failed-attempt lock, exactly as sign-in treats it.
const parseCurrentPassword = (currentPassword: string): string => {
  try {
    return parsePassword(currentPassword);
  } catch (error) {
    if (!(error instanceof CredentialsAuthError)) throw error;
    throw new CredentialsAuthError("invalid_current_password", 400, "Password saat ini salah.");
  }
};

export type PasswordChangeOutcome =
  | { outcome: "changed"; email: string; name: string }
  | { outcome: "rate_limited"; retryAfterSeconds: number }
  | { outcome: "limiter_unavailable" };

/**
 * Changes the signed-in account's password, then signs it out everywhere.
 *
 * THE LIMITER IS CHECKED BEFORE THE CURRENT PASSWORD IS VERIFIED, so a limited account does no
 * scrypt work. It fails CLOSED: when Redis cannot confirm the failure count, nothing is verified.
 */
export const changePassword = async (
  params: { userId: string; currentPassword: unknown; newPassword: unknown },
  db: Database = getDb(),
): Promise<PasswordChangeOutcome> => {
  const { userId, currentPassword, newPassword } = params;
  const failedAttemptKey = `${PASSWORD_CHANGE_FAILED_ATTEMPT_LIMIT.keyPrefix}${userId}`;

  if (typeof currentPassword !== "string") {
    throw new CredentialsAuthError("invalid_payload", 400, "Payload must include currentPassword");
  }

  let attempts: { limited: boolean; retryAfterSeconds: number };
  try {
    attempts = await checkFailedAttemptLimitFailClosed({
      key: failedAttemptKey,
      limit: PASSWORD_CHANGE_FAILED_ATTEMPT_LIMIT.limit,
      windowSeconds: PASSWORD_CHANGE_FAILED_ATTEMPT_LIMIT.windowSeconds,
    });
  } catch {
    return { outcome: "limiter_unavailable" };
  }

  if (attempts.limited) {
    return { outcome: "rate_limited", retryAfterSeconds: attempts.retryAfterSeconds };
  }

  const [account] = await db
    .select({
      email: users.email,
      name: users.name,
      passwordHash: userPasswordCredentials.passwordHash,
    })
    .from(users)
    .leftJoin(userPasswordCredentials, eq(userPasswordCredentials.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!account?.passwordHash) {
    throw new CredentialsAuthError(
      "password_not_set",
      409,
      "Akun ini masuk dengan Google dan tidak memiliki password.",
    );
  }

  const currentMatches = await verifyPassword(
    parseCurrentPassword(currentPassword),
    account.passwordHash,
  );

  if (!currentMatches) {
    try {
      await recordFailedAttemptFailClosed({
        key: failedAttemptKey,
        windowSeconds: PASSWORD_CHANGE_FAILED_ATTEMPT_LIMIT.windowSeconds,
      });
    } catch {
      return { outcome: "limiter_unavailable" };
    }

    throw new CredentialsAuthError("invalid_current_password", 400, "Password saat ini salah.");
  }

  const validNewPassword = parsePassword(newPassword);
  const newPasswordHash = await hashPassword(validNewPassword);

  await db.transaction(async (tx) => {
    const now = new Date();

    await tx
      .update(userPasswordCredentials)
      .set({ passwordHash: newPasswordHash, updatedAt: now })
      .where(eq(userPasswordCredentials.userId, userId));

    await tx
      .update(users)
      .set({ sessionsInvalidBefore: now, updatedAt: now })
      .where(eq(users.id, userId));

    await tx
      .delete(userPasswordResetTokens)
      .where(
        and(eq(userPasswordResetTokens.userId, userId), isNull(userPasswordResetTokens.consumedAt)),
      );
  });

  await clearFailedAttempts(failedAttemptKey);

  return { outcome: "changed", email: account.email, name: account.name ?? FALLBACK_DISPLAY_NAME };
};
