// @vitest-environment node
//
// The MFA guards, run against a real Postgres — the finance-schema-db.integration.test.ts pattern
// (DEC-0142). The unit suite mocks the database, so `tx.update`/`tx.insert` are no-ops and deleting
// a CHECK, a unique index, or the lockout counter's own update statement leaves the whole mocked
// suite green. Only Postgres can settle whether a constraint is actually there and actually fires,
// and every test here is written so that deleting its guard makes it FAIL (a row that should be
// refused would simply be accepted; a lockout that should engage would simply not).
//
// Every test runs inside a transaction that is ALWAYS rolled back, so the dev database is left
// byte-identical. Nothing here is committed.
//
// SKIPPED when DATABASE_URL is absent, so CI (which has no database) stays green; joined to the
// nightly Postgres-service-container job per DEC-0142 (see .github/workflows/verify.yml).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TransactionRollbackError, eq } from "drizzle-orm";
import postgres from "postgres";
import { mfaFactors, mfaRecoveryCodes, platformOpsAuditLogs, users } from "@/server/db/schema";
import { MFA_LOCKOUT_SECONDS } from "@/server/auth/mfa/mfa-core";
import { hasVerifiedMfaFactorSql } from "./mfa-factor-sql";

const resolveDatabaseUrl = (): string | undefined => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return undefined;

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^DATABASE_URL=(.*)$/);
    if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
};

const DATABASE_URL = resolveDatabaseUrl();

// Set BEFORE any dynamic import of factor-service/recovery-service (which happens inside each test
// body, well after this module's top-level statements run) so env.server.ts's module-load-time
// snapshot of process.env picks it up. A fixed, deterministic key — never a real secret.
process.env.MFA_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

const inRollback = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("no database");
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

const expectRejection = async (
  tx: Tx,
  body: (tx: Tx) => Promise<unknown>,
): Promise<{ code: string; constraint: string }> => {
  try {
    await tx.transaction(async (nested) => {
      await body(nested);
    });
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; current && depth < 5; depth += 1) {
      const e = current as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
      if (typeof e.code === "string") {
        return { code: e.code, constraint: e.constraint_name ?? e.constraint ?? "" };
      }
      current = e.cause;
    }
    throw error;
  }
  throw new Error("expected the database to refuse this row, but it was accepted");
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

const seedUser = async (tx: Tx): Promise<string> => {
  const id = uniqueSuffix();
  const [user] = await tx
    .insert(users)
    .values({
      email: `mfa_${id}@example.test`,
      username: `mfa_${id}`,
      role: "platform_ops",
      // users_one_verified_role_chk requires at least one verified role, backfill-style.
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return user!.id;
};

// GUARD-REMOVAL PROOF target: the correlated subquery behind the whole MFA gate.
//
// `hasVerifiedMfaFactorSql` decides `mfaStatus` for every operational session, and a mocked test
// cannot see it at all — it is a SQL string, so a version that always answers `false` passes every
// unit test in the suite while locking every platform_ops and finance_ops account out of every
// guarded surface (the gate sends them to /auth/mfa/enroll, which then refuses them
// `mfa_already_enrolled` because they ARE enrolled). That is exactly the shape this shipped in.
//
// The failure mode is silent by construction: interpolating the outer column renders a bare `"id"`
// that Postgres resolves happily — to the WRONG table — so there is no error to notice, only a
// wrong answer. Both directions are asserted, because a subquery that always answers `true` is
// equally broken and equally silent.
describe.skipIf(!DATABASE_URL)("hasVerifiedMfaFactorSql (real database)", () => {
  const readFlag = async (tx: Tx, userId: string): Promise<boolean> => {
    const [row] = await tx
      .select({ hasVerifiedMfaFactor: hasVerifiedMfaFactorSql })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row!.hasVerifiedMfaFactor;
  };

  it("answers false with no factor, false with an unverified one, and true once verified", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);

      expect(await readFlag(tx, userId)).toBe(false);

      await tx.insert(mfaFactors).values({
        userId,
        encryptedSecret: "ciphertext",
        secretIv: "iv",
        secretAuthTag: "tag",
      });
      expect(await readFlag(tx, userId)).toBe(false);

      await tx.update(mfaFactors).set({ verifiedAt: new Date() }).where(eq(mfaFactors.userId, userId));
      expect(await readFlag(tx, userId)).toBe(true);
    });
  });

  it("does not leak another account's factor — the correlation is on users.id, not on any row id", async () => {
    await inRollback(async (tx) => {
      const enrolled = await seedUser(tx);
      const bare = await seedUser(tx);

      await tx.insert(mfaFactors).values({
        userId: enrolled,
        encryptedSecret: "ciphertext",
        secretIv: "iv",
        secretAuthTag: "tag",
        verifiedAt: new Date(),
      });

      expect(await readFlag(tx, enrolled)).toBe(true);
      expect(await readFlag(tx, bare)).toBe(false);
    });
  });
});

describe.skipIf(!DATABASE_URL)("mfa_factors constraints (real database)", () => {
  it("refuses a second factor row for the same user — one factor per account", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);
      await tx.insert(mfaFactors).values({
        userId,
        encryptedSecret: "a",
        secretIv: "b",
        secretAuthTag: "c",
      });

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(mfaFactors).values({
          userId,
          encryptedSecret: "d",
          secretIv: "e",
          secretAuthTag: "f",
        }),
      );

      expect(rejection.code).toBe("23505");
      expect(rejection.constraint).toBe("mfa_factors_user_id_unique_idx");
    });
  });

  it("refuses a negative failed_attempt_count", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(mfaFactors).values({
          userId,
          encryptedSecret: "a",
          secretIv: "b",
          secretAuthTag: "c",
          failedAttemptCount: -1,
        }),
      );

      expect(rejection.constraint).toBe("mfa_factors_failed_attempt_count_chk");
    });
  });

  it("cascades a factor's deletion when its user is deleted", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);
      const [factor] = await tx
        .insert(mfaFactors)
        .values({ userId, encryptedSecret: "a", secretIv: "b", secretAuthTag: "c" })
        .returning({ id: mfaFactors.id });

      await tx.delete(users).where(eq(users.id, userId));

      const remaining = await tx.select().from(mfaFactors).where(eq(mfaFactors.id, factor!.id));
      expect(remaining).toHaveLength(0);
    });
  });
});

describe.skipIf(!DATABASE_URL)("mfa_recovery_codes constraints (real database)", () => {
  it("refuses two codes sharing the same hash", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);
      const sharedHash = `hash_${uniqueSuffix()}`;
      await tx.insert(mfaRecoveryCodes).values({ userId, codeHash: sharedHash });

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(mfaRecoveryCodes).values({ userId, codeHash: sharedHash }),
      );

      expect(rejection.code).toBe("23505");
      expect(rejection.constraint).toBe("mfa_recovery_codes_code_hash_unique_idx");
    });
  });

  it("cascades recovery codes' deletion when their user is deleted", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);
      await tx.insert(mfaRecoveryCodes).values({ userId, codeHash: `h_${uniqueSuffix()}` });

      await tx.delete(users).where(eq(users.id, userId));

      const remaining = await tx
        .select()
        .from(mfaRecoveryCodes)
        .where(eq(mfaRecoveryCodes.userId, userId));
      expect(remaining).toHaveLength(0);
    });
  });
});

describe.skipIf(!DATABASE_URL)("MFA lifecycle end to end (real database)", () => {
  it("enrols, confirms, and challenges successfully, with an audit row for enrolment", async () => {
    await inRollback(async (tx) => {
      const { startMfaEnrolment, confirmMfaEnrolment, challengeMfaFactor } = await import(
        "@/server/auth/mfa/factor-service"
      );
      const { generateTotpCode } = await import("@/server/auth/mfa/totp");
      const { base32Decode } = await import("@/server/auth/mfa/base32");

      const userId = await seedUser(tx);
      const now = new Date("2026-08-10T00:00:00.000Z");

      const enrolment = await startMfaEnrolment(userId, tx as never);
      const secret = base32Decode(enrolment.secretBase32);
      const code = generateTotpCode(secret, Math.floor(now.getTime() / 1000));

      const confirmation = await confirmMfaEnrolment(userId, code, now, tx as never);
      expect(confirmation.recoveryCodes).toHaveLength(10);

      const audits = await tx
        .select()
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.targetUserId, userId));
      expect(audits.some((row) => row.eventType === "mfa.enrolled")).toBe(true);

      // A later step, a fresh code: the challenge path re-verifies against the now-verified factor.
      const laterNow = new Date(now.getTime() + 60_000);
      const nextCode = generateTotpCode(secret, Math.floor(laterNow.getTime() / 1000));
      await expect(
        challengeMfaFactor(userId, nextCode, laterNow, tx as never),
      ).resolves.toBeUndefined();
    });
  });

  // GUARD-REMOVAL PROOF target: this is the backstop behind the enrol PAGE's own
  // `mfaStatus === "challenge_required"` redirect (src/app/auth/mfa/enroll/page.tsx), which sends a
  // session holding a verified factor to /auth/mfa/challenge before it ever calls startMfaEnrolment.
  // That page check is UX routing, not the enforcement — this is: even a caller that reaches
  // startMfaEnrolment directly (a stolen challenge_required cookie replaying the request, a future
  // regression that drops the page-level redirect) must be refused by the SERVICE itself once a
  // verified factor exists, or a session that has merely not yet solved today's challenge could
  // register a brand-new authenticator and silently pass the gate on its own terms.
  it("refuses to start a new enrolment once the account already holds a verified factor", async () => {
    await inRollback(async (tx) => {
      const { startMfaEnrolment, confirmMfaEnrolment } = await import("@/server/auth/mfa/factor-service");
      const { generateTotpCode } = await import("@/server/auth/mfa/totp");
      const { base32Decode } = await import("@/server/auth/mfa/base32");

      const userId = await seedUser(tx);
      const now = new Date("2026-08-10T00:00:00.000Z");

      const enrolment = await startMfaEnrolment(userId, tx as never);
      const secret = base32Decode(enrolment.secretBase32);
      const code = generateTotpCode(secret, Math.floor(now.getTime() / 1000));
      await confirmMfaEnrolment(userId, code, now, tx as never);

      // The account now holds a VERIFIED factor — exactly the "challenge_required" state a stolen
      // cookie would carry. A second call to startMfaEnrolment for the same user must be refused,
      // not silently overwrite the verified row with a fresh unverified secret.
      await expect(startMfaEnrolment(userId, tx as never)).rejects.toMatchObject({
        code: "mfa_already_enrolled",
      });

      // And the original verified factor must be untouched — still exactly one row, still verified.
      const rows = await tx.select().from(mfaFactors).where(eq(mfaFactors.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.verifiedAt).not.toBeNull();
    });
  });

  // GUARD-REMOVAL PROOF target (real database arm): the replay guard persists lastUsedStep to the
  // ROW, so a second attempt with the exact same code — even in a brand-new call, reading the row
  // fresh from Postgres rather than from an in-memory object — is refused. This is the proof a
  // mocked test cannot give: a mock has no row to persist to.
  it("refuses the exact same code presented twice, persisted through real rows", async () => {
    await inRollback(async (tx) => {
      const { startMfaEnrolment, confirmMfaEnrolment, challengeMfaFactor } = await import(
        "@/server/auth/mfa/factor-service"
      );
      const { generateTotpCode } = await import("@/server/auth/mfa/totp");
      const { base32Decode } = await import("@/server/auth/mfa/base32");

      const userId = await seedUser(tx);
      const now = new Date("2026-08-10T00:00:00.000Z");

      const enrolment = await startMfaEnrolment(userId, tx as never);
      const secret = base32Decode(enrolment.secretBase32);
      const code = generateTotpCode(secret, Math.floor(now.getTime() / 1000));
      await confirmMfaEnrolment(userId, code, now, tx as never);

      const sameCodeAgain = generateTotpCode(secret, Math.floor(now.getTime() / 1000));
      expect(sameCodeAgain).toBe(code);

      await expect(challengeMfaFactor(userId, sameCodeAgain, now, tx as never)).rejects.toMatchObject(
        { code: "mfa_invalid_code" },
      );

      const [row] = await tx.select().from(mfaFactors).where(eq(mfaFactors.userId, userId));
      // The replay attempt is a failed attempt like any other, incrementing the shared counter.
      expect(row?.failedAttemptCount).toBe(1);
    });
  });

  // GUARD-REMOVAL PROOF target: the lockout threshold and the database-persisted counter. Five
  // real, separate calls — not five iterations against one in-memory object — each reading the
  // updated row Postgres actually holds.
  it("locks the factor out after five consecutive failed challenges, and refuses a sixth even with the correct code", async () => {
    await inRollback(async (tx) => {
      const { startMfaEnrolment, confirmMfaEnrolment, challengeMfaFactor } = await import(
        "@/server/auth/mfa/factor-service"
      );
      const { generateTotpCode } = await import("@/server/auth/mfa/totp");
      const { base32Decode } = await import("@/server/auth/mfa/base32");

      const userId = await seedUser(tx);
      const now = new Date("2026-08-10T00:00:00.000Z");

      const enrolment = await startMfaEnrolment(userId, tx as never);
      const secret = base32Decode(enrolment.secretBase32);
      const goodCode = generateTotpCode(secret, Math.floor(now.getTime() / 1000));
      await confirmMfaEnrolment(userId, goodCode, now, tx as never);

      // Five consecutive wrong codes — the fifth is the one that crosses MFA_LOCKOUT_THRESHOLD and
      // engages the lock; all five are still reported as an ordinary invalid-code refusal, matching
      // the credentials-login precedent (the lockout is a SIDE EFFECT of the attempt, not itself an
      // extra error code on the attempt that triggers it). What the fifth DOES carry is
      // `retryAfterSeconds`, so the operator learns about the lock from the attempt that caused it
      // rather than from the next one behaving differently.
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await expect(
          challengeMfaFactor(userId, "000000", now, tx as never),
        ).rejects.toMatchObject({
          code: "mfa_invalid_code",
          retryAfterSeconds: attempt === 5 ? MFA_LOCKOUT_SECONDS : null,
        });
      }

      const [locked] = await tx.select().from(mfaFactors).where(eq(mfaFactors.userId, userId));
      expect(locked?.lockedUntil).not.toBeNull();
      expect(locked?.failedAttemptCount).toBe(0);

      const auditRows = await tx
        .select()
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.targetUserId, userId));
      expect(auditRows.some((row) => row.eventType === "mfa.locked_out")).toBe(true);

      // Even the CORRECT current code is refused while locked — a locked-out factor does no crypto.
      const laterNow = new Date(now.getTime() + 60_000);
      const correctCode = generateTotpCode(secret, Math.floor(laterNow.getTime() / 1000));
      // The duration reported here is what REMAINS, not the full lockout: a minute has passed, so
      // reporting 900 again would tell the operator to wait longer than the lock actually holds.
      await expect(
        challengeMfaFactor(userId, correctCode, laterNow, tx as never),
      ).rejects.toMatchObject({
        code: "mfa_locked_out",
        retryAfterSeconds: MFA_LOCKOUT_SECONDS - 60,
      });
    });
  });

  it("redeeming a recovery code deletes the factor, stamps mfa_invalidated_at, and audits both events", async () => {
    await inRollback(async (tx) => {
      const { startMfaEnrolment, confirmMfaEnrolment, redeemMfaRecoveryCode } = await import(
        "@/server/auth/mfa/factor-service"
      );
      const { generateTotpCode } = await import("@/server/auth/mfa/totp");
      const { base32Decode } = await import("@/server/auth/mfa/base32");

      const userId = await seedUser(tx);
      const now = new Date("2026-08-10T00:00:00.000Z");

      const enrolment = await startMfaEnrolment(userId, tx as never);
      const secret = base32Decode(enrolment.secretBase32);
      const code = generateTotpCode(secret, Math.floor(now.getTime() / 1000));
      const confirmation = await confirmMfaEnrolment(userId, code, now, tx as never);

      const redeemAt = new Date(now.getTime() + 3600_000);
      await redeemMfaRecoveryCode(userId, confirmation.recoveryCodes[0]!, redeemAt, tx as never);

      const [factorRow] = await tx.select().from(mfaFactors).where(eq(mfaFactors.userId, userId));
      expect(factorRow).toBeUndefined();

      const [userRow] = await tx.select().from(users).where(eq(users.id, userId));
      expect(userRow?.mfaInvalidatedAt?.getTime()).toBe(redeemAt.getTime());

      const auditRows = await tx
        .select()
        .from(platformOpsAuditLogs)
        .where(eq(platformOpsAuditLogs.targetUserId, userId));
      expect(auditRows.some((row) => row.eventType === "mfa.recovery_code_used")).toBe(true);
      expect(auditRows.some((row) => row.eventType === "mfa.reset")).toBe(true);
    });
  });

  it("refuses to redeem the same recovery code twice", async () => {
    await inRollback(async (tx) => {
      const { startMfaEnrolment, confirmMfaEnrolment, redeemMfaRecoveryCode } = await import(
        "@/server/auth/mfa/factor-service"
      );
      const { generateTotpCode } = await import("@/server/auth/mfa/totp");
      const { base32Decode } = await import("@/server/auth/mfa/base32");

      const userId = await seedUser(tx);
      const now = new Date("2026-08-10T00:00:00.000Z");

      const enrolment = await startMfaEnrolment(userId, tx as never);
      const secret = base32Decode(enrolment.secretBase32);
      const code = generateTotpCode(secret, Math.floor(now.getTime() / 1000));
      const confirmation = await confirmMfaEnrolment(userId, code, now, tx as never);

      const usedCode = confirmation.recoveryCodes[0]!;
      const firstRedeemAt = new Date(now.getTime() + 3600_000);

      // First redemption succeeds and deletes the factor — re-enrol so the second attempt below
      // reaches the recovery-code lookup rather than redeemMfaRecoveryCode's separate
      // "no verified factor at all" guard, which would mask the assertion actually under test:
      // that the SAME code cannot be redeemed a second time.
      await redeemMfaRecoveryCode(userId, usedCode, firstRedeemAt, tx as never);

      const secondEnrolment = await startMfaEnrolment(userId, tx as never);
      const secondSecret = base32Decode(secondEnrolment.secretBase32);
      const secondConfirmAt = new Date(firstRedeemAt.getTime() + 1000);
      const secondCode = generateTotpCode(secondSecret, Math.floor(secondConfirmAt.getTime() / 1000));
      await confirmMfaEnrolment(userId, secondCode, secondConfirmAt, tx as never);

      await expect(
        redeemMfaRecoveryCode(userId, usedCode, new Date(secondConfirmAt.getTime() + 1000), tx as never),
      ).rejects.toMatchObject({ code: "mfa_invalid_recovery_code" });
    });
  });
});
