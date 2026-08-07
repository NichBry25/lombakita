import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { mfaFactors, users, type MfaFactorRecord } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { base32Encode } from "./base32";
import { appendMfaAuditEvent } from "./mfa-audit";
import { decryptMfaSecret, encryptMfaSecret } from "./mfa-encryption";
import { MFA_EVENT, MFA_LOCKOUT_SECONDS, MFA_LOCKOUT_THRESHOLD, MfaError, TOTP_WINDOW_STEPS } from "./mfa-core";
import { consumeRecoveryCode, issueRecoveryCodesInTransaction } from "./recovery-service";
import { verifyTotpCode } from "./totp";

assertServerOnly("server/auth/mfa/factor-service");

// The TOTP factor lifecycle for platform_ops / finance_ops accounts:
// enrol, confirm, challenge, lock out, and recover. Every write here that changes access state
// shares a transaction with its `platform_ops_audit_logs` row (CLAUDE.md Rule 7 / DEC-0114), and
// every one of those rows is written through `appendMfaAuditEvent`, which takes the actor as a
// leading positional parameter so no payload spread can supply it (DEC-0140). The actor is always
// the account itself — these are self-initiated identity events, not one operator acting on another.

const TOTP_SECRET_BYTE_LENGTH = 20; // 160 bits, the RFC 4226 recommended HOTP secret length
const OTPAUTH_ISSUER = "Lombakita";

const buildOtpauthUri = (accountLabel: string, secretBase32: string): string => {
  const label = encodeURIComponent(`${OTPAUTH_ISSUER}:${accountLabel}`);
  const issuer = encodeURIComponent(OTPAUTH_ISSUER);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
};

const isFactorLocked = (factor: Pick<MfaFactorRecord, "lockedUntil">, now: Date): boolean => {
  return factor.lockedUntil !== null && factor.lockedUntil.getTime() > now.getTime();
};

/**
 * Seconds still to run on an engaged lock. Rounded UP and floored at 1 so a lock with 200ms left is
 * never reported as "0 seconds", which reads as "not locked" to a caller and to a `Retry-After`
 * header alike.
 */
const remainingLockSeconds = (factor: Pick<MfaFactorRecord, "lockedUntil">, now: Date): number => {
  if (factor.lockedUntil === null) {
    return 0;
  }
  return Math.max(1, Math.ceil((factor.lockedUntil.getTime() - now.getTime()) / 1000));
};

const decryptFactorSecret = (factor: MfaFactorRecord): Buffer => {
  return decryptMfaSecret({
    ciphertext: factor.encryptedSecret,
    iv: factor.secretIv,
    authTag: factor.secretAuthTag,
  });
};

/**
 * Records one failed proof-of-possession attempt (a TOTP challenge or a recovery-code guess share
 * this single counter — both are an attempt to prove control of the same factor). On the attempt
 * that reaches the threshold, resets the counter and engages a timed lock, and writes the
 * `mfa.locked_out` audit row in the SAME transaction as the lock. A database counter, not the
 * fail-open Redis limiter, is what makes the lock hold through a Redis outage.
 *
 * The increment is an ATOMIC SQL expression (`failed_attempt_count + 1`), never a value computed in
 * JS from the caller's already-stale `factor` read: two concurrent failed attempts against the same
 * row would otherwise both compute the same "next" value from the same starting count and one
 * increment would be lost, silently widening the guessable window past MFA_LOCKOUT_THRESHOLD. The
 * row lock this UPDATE takes is held until the transaction commits, so a second concurrent caller's
 * own UPDATE — once unblocked — is guaranteed to add 1 to whatever this one just committed, never to
 * the value it read before either started.
 *
 * Returns the lock duration when THIS attempt is the one that engaged the lock, and null otherwise,
 * so the caller can report the consequence on the same refusal that caused it.
 */
const applyFailedAttempt = async (
  tx: Database,
  factor: MfaFactorRecord,
  now: Date,
): Promise<number | null> => {
  const [updated] = await tx
    .update(mfaFactors)
    .set({ failedAttemptCount: sql`${mfaFactors.failedAttemptCount} + 1`, updatedAt: now })
    .where(eq(mfaFactors.id, factor.id))
    .returning({ failedAttemptCount: mfaFactors.failedAttemptCount });

  // No row means the factor is gone, so there is nothing to lock and nothing to record. Falling
  // back to the caller's already-read count would decide a lockout from a stale number and write an
  // `mfa.locked_out` row for a lock that no UPDATE actually engaged. Unreachable through the three
  // service entry points — each holds this row under `FOR UPDATE` for the whole transaction — and
  // kept as the honest answer for any future caller that does not.
  if (!updated) {
    return null;
  }

  if (updated.failedAttemptCount >= MFA_LOCKOUT_THRESHOLD) {
    await tx
      .update(mfaFactors)
      .set({
        failedAttemptCount: 0,
        lockedUntil: new Date(now.getTime() + MFA_LOCKOUT_SECONDS * 1000),
        updatedAt: now,
      })
      .where(eq(mfaFactors.id, factor.id));

    await appendMfaAuditEvent(factor.userId, tx, {
      eventType: MFA_EVENT.lockedOut,
      reason: `${MFA_LOCKOUT_THRESHOLD} consecutive failed MFA attempts`,
    });

    return MFA_LOCKOUT_SECONDS;
  }

  return null;
};

const clearFailedAttempts = async (
  tx: Database,
  factorId: string,
  matchedStep: number,
  now: Date,
): Promise<void> => {
  await tx
    .update(mfaFactors)
    .set({ lastUsedStep: matchedStep, failedAttemptCount: 0, lockedUntil: null, updatedAt: now })
    .where(eq(mfaFactors.id, factorId));
};

/**
 * Reads the account's factor row and HOLDS IT for the rest of the caller's transaction (`FOR
 * UPDATE`), which is what makes the lockout counter mean anything.
 *
 * A plain SELECT here made every guard in this module time-of-check-to-time-of-use: N requests
 * arriving together all read `locked_until` as null, all decrypted the secret and all verified their
 * codes before any of them reached the counter, so the threshold bounded the number of ATTEMPTS
 * RECORDED and not the number of GUESSES TAKEN. The bound was not small and constant — it was
 * however many requests an attacker could have in flight at once, and these routes carry no Redis
 * limiter, so this counter is the only throttle on the endpoint. The same window let a correct code
 * racing the threshold-crossing wrong one clear `locked_until` a moment after it engaged, leaving an
 * `mfa.locked_out` audit row describing a lock that was not in force.
 *
 * A row lock rather than an advisory lock because this is a single existing row (CLAUDE.md Rule 25),
 * and because a locking read reports a row DELETED by the transaction it waited on as absent —
 * exactly the answer a redemption-versus-challenge race needs. Postgres re-evaluates the read
 * against the freshly committed row once the lock is granted, so a caller that waits here sees the
 * winner's lockout, never the snapshot it would have taken had it not waited.
 */
const loadFactorForUser = async (tx: Database, userId: string): Promise<MfaFactorRecord | null> => {
  const [factor] = await tx
    .select()
    .from(mfaFactors)
    .where(eq(mfaFactors.userId, userId))
    .limit(1)
    .for("update");
  return factor ?? null;
};

export type MfaEnrolmentStart = { secretBase32: string; otpauthUri: string };

/**
 * Starts (or restarts) enrolment: mints a fresh secret and stores it UNVERIFIED. Re-starting an
 * abandoned enrolment overwrites the previous unverified row in place — the one-factor-per-user
 * unique index means this MUST be an UPDATE, never a second INSERT. Refuses outright if the account
 * already holds a VERIFIED factor: that account resets only through recovery-code redemption or the
 * documented break-glass procedure, never by simply starting over.
 */
export const startMfaEnrolment = async (
  userId: string,
  db: Database = getDb(),
): Promise<MfaEnrolmentStart> => {
  return db.transaction(async (tx) => {
    const existing = await loadFactorForUser(tx, userId);

    if (existing?.verifiedAt) {
      throw new MfaError("mfa_already_enrolled", 409, "This account already has a verified MFA factor");
    }

    const [account] = await tx
      .select({ email: users.email, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!account) {
      throw new Error(`startMfaEnrolment: no users row for ${userId}`);
    }

    const secret = randomBytes(TOTP_SECRET_BYTE_LENGTH);
    const encrypted = encryptMfaSecret(secret);
    const now = new Date();

    if (existing) {
      await tx
        .update(mfaFactors)
        .set({
          encryptedSecret: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretAuthTag: encrypted.authTag,
          lastUsedStep: null,
          failedAttemptCount: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(mfaFactors.id, existing.id));
    } else {
      await tx.insert(mfaFactors).values({
        userId,
        encryptedSecret: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
      });
    }

    const secretBase32 = base32Encode(secret);
    return {
      secretBase32,
      otpauthUri: buildOtpauthUri(account.email ?? account.username, secretBase32),
    };
  });
};

export type MfaEnrolmentConfirmation = { recoveryCodes: string[] };

/**
 * Confirms a pending enrolment with the first TOTP code from the operator's authenticator app.
 * On success: marks the factor verified, mints the ten recovery codes (their only appearance in
 * plaintext), and writes `mfa.enrolled` — all in one transaction.
 */
// Every one of the three functions below shares a hazard that only a REAL transaction can surface:
// throwing INSIDE `db.transaction()` rolls back everything that callback did — including a failed-
// attempt counter increment or a lockout it just wrote a moment earlier. A mocked test cannot catch
// this (`tx.update` is a no-op either way), but a real Postgres run proved it: a rejected replayed
// code left `failed_attempt_count` at 0 instead of 1, because the throw that reported the rejection
// to the caller also erased the counter bump that was supposed to survive it.
//
// The fix is the same shape in all three: the transaction callback returns a DISCRIMINATED outcome
// and never throws, so every write inside it commits regardless of which outcome is reached; the
// corresponding MfaError is thrown AFTER the transaction has committed, from the plain value the
// transaction returned.
//
// The two refusal variants that can be reached WHILE or BY a lockout carry `retryAfterSeconds`:
// `locked_out` always (the lock is why the attempt was refused), and `invalid_code` /
// `invalid_recovery_code` only on the attempt whose own failure engaged the lock. The error code is
// unchanged on that attempt — it really was a wrong code, and the lock is its side effect — but the
// duration travels with it so the operator is not told the same thing five times and then
// mysteriously refused on the sixth.
type MfaOutcome<TSuccess> =
  | { kind: "success"; value: TSuccess }
  | { kind: "enrolment_not_found" }
  | { kind: "not_enrolled" }
  | { kind: "locked_out"; retryAfterSeconds: number }
  | { kind: "invalid_code"; retryAfterSeconds: number | null }
  | { kind: "invalid_recovery_code"; retryAfterSeconds: number | null };

// Failure variants carry no `value`, so they are structurally identical across every generic
// instantiation of MfaOutcome<T> — this lets one non-generic helper serve all three call sites.
type MfaFailureOutcome = Exclude<MfaOutcome<never>, { kind: "success" }>;

// Typed as returning `never`, not `void`: this is what lets a caller write
// `if (outcome.kind !== "success") throwForOutcome(outcome);` and have TypeScript narrow `outcome`
// to the success variant on the following line, without a redundant `return`/`throw` after it.
const throwForOutcome = (outcome: MfaFailureOutcome): never => {
  switch (outcome.kind) {
    case "enrolment_not_found":
      throw new MfaError("mfa_enrolment_not_found", 404, "No pending MFA enrolment for this account");
    case "not_enrolled":
      throw new MfaError("mfa_not_enrolled", 404, "No verified MFA factor for this account");
    case "locked_out":
      throw new MfaError(
        "mfa_locked_out",
        423,
        "Too many failed attempts — try again later",
        outcome.retryAfterSeconds,
      );
    case "invalid_code":
      throw new MfaError("mfa_invalid_code", 401, "Invalid verification code", outcome.retryAfterSeconds);
    case "invalid_recovery_code":
      throw new MfaError(
        "mfa_invalid_recovery_code",
        401,
        "Invalid or already-used recovery code",
        outcome.retryAfterSeconds,
      );
  }
};

export const confirmMfaEnrolment = async (
  userId: string,
  code: string,
  now: Date,
  db: Database = getDb(),
): Promise<MfaEnrolmentConfirmation> => {
  const outcome = await db.transaction(async (tx): Promise<MfaOutcome<MfaEnrolmentConfirmation>> => {
    const factor = await loadFactorForUser(tx, userId);

    if (!factor || factor.verifiedAt) {
      return { kind: "enrolment_not_found" };
    }

    if (isFactorLocked(factor, now)) {
      return { kind: "locked_out", retryAfterSeconds: remainingLockSeconds(factor, now) };
    }

    const secret = decryptFactorSecret(factor);
    const verification = verifyTotpCode(secret, code, Math.floor(now.getTime() / 1000), {
      windowSteps: TOTP_WINDOW_STEPS,
      lastAcceptedStep: factor.lastUsedStep,
    });

    if (!verification.valid || verification.matchedStep === null) {
      const retryAfterSeconds = await applyFailedAttempt(tx, factor, now);
      return { kind: "invalid_code", retryAfterSeconds };
    }

    await tx
      .update(mfaFactors)
      .set({
        verifiedAt: now,
        lastUsedStep: verification.matchedStep,
        failedAttemptCount: 0,
        lockedUntil: null,
        updatedAt: now,
      })
      .where(eq(mfaFactors.id, factor.id));

    const recoveryCodes = await issueRecoveryCodesInTransaction(tx, userId, now);

    await appendMfaAuditEvent(userId, tx, { eventType: MFA_EVENT.enrolled });

    return { kind: "success", value: { recoveryCodes } };
  });

  if (outcome.kind === "success") {
    return outcome.value;
  }
  return throwForOutcome(outcome);
};

/**
 * Verifies a TOTP code against the account's already-VERIFIED factor. Throws `mfa_not_enrolled`,
 * `mfa_locked_out`, or `mfa_invalid_code`; returns nothing on success (the caller — the API route —
 * is what issues the elevation grant, keeping this module ignorant of Redis).
 */
export const challengeMfaFactor = async (
  userId: string,
  code: string,
  now: Date,
  db: Database = getDb(),
): Promise<void> => {
  const outcome = await db.transaction(async (tx): Promise<MfaOutcome<void>> => {
    const factor = await loadFactorForUser(tx, userId);

    if (!factor || !factor.verifiedAt) {
      return { kind: "not_enrolled" };
    }

    if (isFactorLocked(factor, now)) {
      return { kind: "locked_out", retryAfterSeconds: remainingLockSeconds(factor, now) };
    }

    const secret = decryptFactorSecret(factor);
    const verification = verifyTotpCode(secret, code, Math.floor(now.getTime() / 1000), {
      windowSteps: TOTP_WINDOW_STEPS,
      lastAcceptedStep: factor.lastUsedStep,
    });

    if (!verification.valid || verification.matchedStep === null) {
      const retryAfterSeconds = await applyFailedAttempt(tx, factor, now);
      return { kind: "invalid_code", retryAfterSeconds };
    }

    await clearFailedAttempts(tx, factor.id, verification.matchedStep, now);
    return { kind: "success", value: undefined };
  });

  if (outcome.kind !== "success") {
    throwForOutcome(outcome);
  }
};

/**
 * Redeems a recovery code. On success this is a RESET, not merely a login: the code is marked
 * used, the factor (and every other still-unused code) is deleted, and `users.mfa_invalidated_at`
 * is stamped — which, read by the DEC-0112-style live comparison in the session callback, forces
 * EVERY outstanding operational session for this account back to `enrolment_required`, not only
 * the one making this call. This is deliberate: a recovery code is what you reach for when a device
 * is lost, and a lost device may still be carrying another live session.
 */
export const redeemMfaRecoveryCode = async (
  userId: string,
  rawCode: string,
  now: Date,
  db: Database = getDb(),
): Promise<void> => {
  const outcome = await db.transaction(async (tx): Promise<MfaOutcome<void>> => {
    const factor = await loadFactorForUser(tx, userId);

    if (!factor || !factor.verifiedAt) {
      return { kind: "not_enrolled" };
    }

    if (isFactorLocked(factor, now)) {
      return { kind: "locked_out", retryAfterSeconds: remainingLockSeconds(factor, now) };
    }

    const match = await consumeRecoveryCode(tx, userId, rawCode, now);

    if (!match) {
      const retryAfterSeconds = await applyFailedAttempt(tx, factor, now);
      return { kind: "invalid_recovery_code", retryAfterSeconds };
    }

    await tx.delete(mfaFactors).where(eq(mfaFactors.id, factor.id));
    await tx.update(users).set({ mfaInvalidatedAt: now, updatedAt: now }).where(eq(users.id, userId));

    await appendMfaAuditEvent(userId, tx, { eventType: MFA_EVENT.recoveryCodeUsed });
    await appendMfaAuditEvent(userId, tx, {
      eventType: MFA_EVENT.reset,
      reason: "recovery code redemption",
    });

    return { kind: "success", value: undefined };
  });

  if (outcome.kind !== "success") {
    throwForOutcome(outcome);
  }
};
