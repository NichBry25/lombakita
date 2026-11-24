// @vitest-environment node

// The Email organisasi code against real rows. Most tests run in a transaction that is always rolled
// back, with accounts made through the real sign-up, code verification and role services. A row is
// planted directly only where a test stands in for the clock, and each such place says so.
//
// The last describe COMMITS, because one connection cannot wait on itself: each racer gets its own
// connection, and a third connection holds the lock or the uncommitted row the service is expected to
// wait on, so every racer is provably queued before any is let through. A lock that is removed makes those tests
// fail at the queue check and not flake.

import { randomUUID } from "node:crypto";
import { TransactionRollbackError, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Session } from "next-auth";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  organizationCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
  limiterUnavailable: false,
  codeMatchCalls: 0,
  routeTransaction: null as Database | null,
  routeSession: null as Session | null,
  sweepForAccount: vi.fn().mockResolvedValue(undefined),
  enqueueApproved: vi.fn(),
}));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: { ...actual.serverEnv, authSecret: "test-registration-code-secret" },
  };
});

vi.mock("@/server/auth/email-verification", () => ({
  sendRegistrationVerificationEmail: async (options: { email: string; code: string }) => {
    mocks.sentCodes.push({ email: options.email, code: options.code });
  },
  sendOrganizationEmailCode: async (options: { email: string; code: string }) => {
    mocks.organizationCodes.push({ email: options.email, code: options.code });
  },
}));

vi.mock("@/server/redis/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/redis/rate-limit")>();
  return {
    ...actual,
    checkFixedWindowLimitFailClosed: async (params: {
      key: string;
      limit: number;
      windowSeconds: number;
    }) => {
      if (mocks.limiterUnavailable) return { decision: "unavailable" as const };
      const count = (mocks.windowCounts.get(params.key) ?? 0) + 1;
      mocks.windowCounts.set(params.key, count);
      if (count > params.limit) {
        return { decision: "throttled" as const, retryAfterSeconds: params.windowSeconds };
      }
      return { decision: "allowed" as const };
    },
  };
});

vi.mock("@/server/auth/registration-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/registration-code")>();
  return {
    ...actual,
    registrationCodeMatches: (storedHash: string, userId: string, code: string) => {
      mocks.codeMatchCalls += 1;
      return actual.registrationCodeMatches(storedHash, userId, code);
    },
  };
});

vi.mock("@/server/storage/r2.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/storage/r2.client")>();
  return {
    ...actual,
    isR2Available: () => true,
    listObjects: async () => [],
    deleteObject: async () => undefined,
  };
});

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return { ...actual, enqueueRecruiterVerificationApproved: mocks.enqueueApproved };
});

vi.mock(
  "@/server/recruiter-verification/recruiter-verification-service",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/server/recruiter-verification/recruiter-verification-service")
      >();
    return { ...actual, sweepOrphanedObjectsForAccount: mocks.sweepForAccount };
  },
);

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return { ...actual, getDb: () => mocks.routeTransaction ?? actual.getDb() };
});

vi.mock("next-auth", () => ({
  getServerSession: async () => mocks.routeSession,
}));

vi.mock("@/server/auth/auth.config", () => ({
  authOptions: {},
}));

import { deidentifyAccount } from "@/server/accounts/account-deidentification-service";
import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import {
  OrganizationEmailError,
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "./organization-email-service";
import { POST as confirmRoute } from "@/app/api/v1/me/organization-email/confirm/route";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";

const PASSWORD = "fresh-pass-3";

const CANDIDATE_DETAILS = {
  name: "Rina Pratama",
  signupRole: "candidate",
  fullName: "Rina Pratama",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
};

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;
afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const inRollback = async (test: (tx: Database) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("No test database");
  try {
    await db.transaction(async (tx) => {
      await test(tx as unknown as Database);
      (tx as Tx).rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

beforeEach(() => {
  mocks.sentCodes.length = 0;
  mocks.organizationCodes.length = 0;
  mocks.windowCounts.clear();
  mocks.limiterUnavailable = false;
  mocks.codeMatchCalls = 0;
  mocks.routeTransaction = null;
  mocks.routeSession = null;
});

const latestCode = (): string => {
  const sent = mocks.sentCodes.at(-1);
  if (!sent) throw new Error("No code was sent");
  return sent.code;
};

const latestOrganizationCodeFor = (address: string): string => {
  const sent = mocks.organizationCodes.filter((entry) => entry.email === address).at(-1);
  if (!sent) throw new Error(`No Email organisasi code was sent to ${address}`);
  return sent.code;
};

const wrongCodeFor = (code: string): string => (code === "000000" ? "111111" : "000000");

const userIdOfAddress = async (tx: Database, address: string): Promise<string> => {
  const [row] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, address));
  if (!row) throw new Error("No user row");
  return row.id;
};

const usernameOf = async (tx: Database, userId: string): Promise<string> => {
  const [row] = await tx
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.username;
};

const seedOperator = async (tx: Database): Promise<string> => {
  const suffix = randomUUID();
  const [row] = await tx
    .insert(schema.users)
    .values({
      email: `ops_org_email_${suffix}@example.test`,
      username: `ops_org_email_${suffix}`,
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (!row) throw new Error("No operator row");
  return row.id;
};

const signUpParticipant = async (tx: Database, address: string): Promise<string> => {
  await registerUserWithCredentials(
    { ...CANDIDATE_DETAILS, email: address, password: PASSWORD },
    tx,
  );
  await verifyEmailCodeAndSetPassword(
    { ...CANDIDATE_DETAILS, email: address, code: latestCode(), password: PASSWORD },
    tx,
  );
  return userIdOfAddress(tx, address);
};

const signUpHost = async (tx: Database, address: string): Promise<string> => {
  const userId = await signUpParticipant(tx, address);
  await markRoleAsVerified(userId, "recruiter", null, tx);
  return userId;
};

const tierOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ tier: schema.users.recruiterVerificationTier })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.tier;
};

const organizationEmailRowsOf = (tx: Database, userId: string) =>
  tx
    .select({
      email: schema.hostOrganizationEmails.email,
      domain: schema.hostOrganizationEmails.domain,
    })
    .from(schema.hostOrganizationEmails)
    .where(eq(schema.hostOrganizationEmails.userId, userId));

const challengeRowsOf = (tx: Database, userId: string) =>
  tx
    .select({
      email: schema.organizationEmailChallenges.email,
      failedAttempts: schema.organizationEmailChallenges.failedAttempts,
      consumedAt: schema.organizationEmailChallenges.consumedAt,
    })
    .from(schema.organizationEmailChallenges)
    .where(eq(schema.organizationEmailChallenges.userId, userId))
    .orderBy(schema.organizationEmailChallenges.email);

const challengeRowsForAddress = (tx: Database, address: string) =>
  tx
    .select({ id: schema.organizationEmailChallenges.id })
    .from(schema.organizationEmailChallenges)
    .where(eq(schema.organizationEmailChallenges.email, address));

const refusalOf = async (promise: Promise<unknown>): Promise<OrganizationEmailError> => {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (outcome === null) throw new Error("Expected a refusal, but the call resolved");
  expect(outcome).toBeInstanceOf(OrganizationEmailError);
  return outcome as OrganizationEmailError;
};

const issue = (tx: Database, userId: string, address: string) =>
  issueOrganizationEmailCode(userId, address, tx);

const confirm = (tx: Database, userId: string, code: string) =>
  confirmOrganizationEmailCode(userId, code, tx);

describe.skipIf(skipWithoutDatabase)("Email organisasi code (real database)", () => {
  describe("sending a code", () => {
    it("stores the normalized address and counts two spellings of one address as one address", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpParticipant(tx, "rina.peserta@acme.example");
        const accountB = await signUpParticipant(tx, "dina@acme.example");
        const before = Date.now();

        const issued = await issue(tx, accountA, "Budi@Acme.example ");
        await issue(tx, accountB, "budi@acme.example");

        expect(issued.email).toBe("budi@acme.example");
        const minutesAhead = (issued.expiresAt.getTime() - before) / 60_000;
        expect(minutesAhead).toBeGreaterThan(9);
        expect(minutesAhead).toBeLessThan(11);
        const rowsOfA = await challengeRowsOf(tx, accountA);
        const rowsOfB = await challengeRowsOf(tx, accountB);
        expect(rowsOfA.map((row) => row.email)).toEqual(["budi@acme.example"]);
        expect(rowsOfB.map((row) => row.email)).toEqual(["budi@acme.example"]);
        expect(mocks.organizationCodes.map((entry) => entry.email)).toEqual([
          "budi@acme.example",
          "budi@acme.example",
        ]);
      });
    });

    it("refuses an address that is not one printable ASCII address and writes nothing", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpParticipant(tx, "rina.peserta@acme.example");

        for (const address of [
          "Budİ@acme.example",
          "bu di@acme.example",
          "budi@acme.example.",
          "budi.acme.example",
          "budi@acme",
        ]) {
          const refusal = await refusalOf(issue(tx, accountA, address));
          expect(refusal.code, address).toBe("organization_email_invalid");
          expect(refusal.status, address).toBe(400);
        }

        expect(await challengeRowsOf(tx, accountA)).toEqual([]);
        expect(mocks.organizationCodes).toEqual([]);
      });
    });

    it("refuses a free email domain and writes nothing", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpParticipant(tx, "rina.peserta@acme.example");

        const refusal = await refusalOf(issue(tx, accountA, "rina.free@gmail.com"));

        expect(refusal.code).toBe("organization_email_free_domain");
        expect(refusal.status).toBe(422);
        expect(await challengeRowsOf(tx, accountA)).toEqual([]);
        expect(mocks.organizationCodes).toEqual([]);
      });
    });

    it("refuses a second send by the same account to the same address within 60 seconds", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpParticipant(tx, "rina.peserta@acme.example");
        await issue(tx, accountA, "budi@acme.example");

        const refusal = await refusalOf(issue(tx, accountA, "budi@acme.example"));

        expect(refusal.code).toBe("organization_email_resend_too_soon");
        expect(refusal.status).toBe(429);
        const wait = refusal.details?.retryAfterSeconds;
        expect(Number.isInteger(wait)).toBe(true);
        expect(wait).toBeGreaterThanOrEqual(1);
        expect(wait).toBeLessThanOrEqual(60);
        expect(await challengeRowsOf(tx, accountA)).toHaveLength(1);
      });
    });

    it("lets the same account send to another address and another account send to the same address", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpParticipant(tx, "rina.peserta@acme.example");
        const accountB = await signUpParticipant(tx, "dina@acme.example");

        await issue(tx, accountA, "budi@acme.example");
        await issue(tx, accountA, "dina.panitia@acme.example");
        await issue(tx, accountB, "budi@acme.example");

        expect(await challengeRowsOf(tx, accountA)).toHaveLength(2);
        expect(await challengeRowsOf(tx, accountB)).toHaveLength(1);
      });
    });

    it("refuses a sixth send to one address in a day", async () => {
      await inRollback(async (tx) => {
        const accounts: string[] = [];
        for (let k = 1; k <= 6; k += 1) {
          accounts.push(await signUpParticipant(tx, `peserta.${k}@acme.example`));
        }

        for (const account of accounts.slice(0, 5)) {
          await issue(tx, account, "panitia@acme.example");
        }
        const refusal = await refusalOf(issue(tx, accounts[5]!, "panitia@acme.example"));

        expect(refusal.code).toBe("organization_email_daily_limit");
        expect(refusal.status).toBe(429);
        expect(await challengeRowsForAddress(tx, "panitia@acme.example")).toHaveLength(5);
      });
    }, 60_000);

    it("refuses an eleventh send from one account in a day", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpParticipant(tx, "rina.peserta@acme.example");

        for (let k = 1; k <= 10; k += 1) {
          await issue(tx, accountA, `staff.${k}@acme.example`);
        }
        const refusal = await refusalOf(issue(tx, accountA, "staff.11@acme.example"));

        expect(refusal.code).toBe("organization_email_daily_limit");
        expect(await challengeRowsOf(tx, accountA)).toHaveLength(10);
      });
    });

    it("removes challenges older than a day before it counts", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpParticipant(tx, "rina.peserta@acme.example");
        const accountB = await signUpParticipant(tx, "dina@acme.example");
        // Planted directly: a stand-in for the clock, which a rolled-back test cannot move.
        await tx.insert(schema.organizationEmailChallenges).values({
          userId: accountB,
          email: "lama@acme.example",
          codeHash: "planted-code-hash",
          expiresAt: new Date(),
          createdAt: sql`now() - interval '25 hours'`,
        });

        await issue(tx, accountA, "budi@acme.example");

        expect(await challengeRowsOf(tx, accountB)).toEqual([]);
      });
    });
  });

  describe("confirming a code", () => {
    it("confirms an Email organisasi and trusts a host whose sign-in email is free", async () => {
      await inRollback(async (tx) => {
        const hostId = await signUpHost(tx, "rina.free@gmail.com");
        await issue(tx, hostId, "rina@acme.example");

        const confirmed = await confirm(tx, hostId, latestOrganizationCodeFor("rina@acme.example"));

        expect(confirmed).toEqual({
          email: "rina@acme.example",
          trustSource: "organization_email",
        });
        expect(await tierOf(tx, hostId)).toBe("elevated");
        expect(await organizationEmailRowsOf(tx, hostId)).toEqual([
          { email: "rina@acme.example", domain: "acme.example" },
        ]);
        const [challenge] = await challengeRowsOf(tx, hostId);
        expect(challenge?.consumedAt).not.toBeNull();
      });
    });

    it("records the Email organisasi of an account without the host role and does not trust it", async () => {
      await inRollback(async (tx) => {
        const participantId = await signUpParticipant(tx, "rina.peserta@acme.example");
        await issue(tx, participantId, "rina@acme.example");

        const confirmed = await confirm(
          tx,
          participantId,
          latestOrganizationCodeFor("rina@acme.example"),
        );

        expect(confirmed.trustSource).toBeNull();
        expect(await tierOf(tx, participantId)).toBe("unverified");
        expect(await organizationEmailRowsOf(tx, participantId)).toEqual([
          { email: "rina@acme.example", domain: "acme.example" },
        ]);
      });
    });

    it("counts a wrong code and says how many tries are left", async () => {
      await inRollback(async (tx) => {
        const hostId = await signUpHost(tx, "rina.free@gmail.com");
        await issue(tx, hostId, "rina@acme.example");
        const wrong = wrongCodeFor(latestOrganizationCodeFor("rina@acme.example"));

        const refusal = await refusalOf(confirm(tx, hostId, wrong));

        expect(refusal.code).toBe("organization_email_code_invalid");
        expect(refusal.status).toBe(422);
        expect(refusal.details?.attemptsLeft).toBe(4);
        const [challenge] = await challengeRowsOf(tx, hostId);
        expect(challenge?.failedAttempts).toBe(1);
        expect(await organizationEmailRowsOf(tx, hostId)).toEqual([]);
        expect(await tierOf(tx, hostId)).toBe("minimal");
      });
    });

    it("lets the right code through on the fifth try", async () => {
      await inRollback(async (tx) => {
        const hostId = await signUpHost(tx, "rina.free@gmail.com");
        await issue(tx, hostId, "rina@acme.example");
        const right = latestOrganizationCodeFor("rina@acme.example");

        for (const attemptsLeft of [4, 3, 2, 1]) {
          const refusal = await refusalOf(confirm(tx, hostId, wrongCodeFor(right)));
          expect(refusal.code).toBe("organization_email_code_invalid");
          expect(refusal.details?.attemptsLeft).toBe(attemptsLeft);
        }
        await confirm(tx, hostId, right);

        const [challenge] = await challengeRowsOf(tx, hostId);
        expect(challenge?.failedAttempts).toBe(5);
        expect(await organizationEmailRowsOf(tx, hostId)).toHaveLength(1);
      });
    });

    it("refuses the right code after five wrong tries without comparing it", async () => {
      await inRollback(async (tx) => {
        const hostId = await signUpHost(tx, "rina.free@gmail.com");
        await issue(tx, hostId, "rina@acme.example");
        const right = latestOrganizationCodeFor("rina@acme.example");
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const refusal = await refusalOf(confirm(tx, hostId, wrongCodeFor(right)));
          expect(refusal.code).toBe("organization_email_code_invalid");
          if (attempt === 5) expect(refusal.details?.attemptsLeft).toBe(0);
        }
        mocks.codeMatchCalls = 0;

        const refusal = await refusalOf(confirm(tx, hostId, right));

        expect(refusal.code).toBe("organization_email_code_locked");
        expect(refusal.status).toBe(422);
        expect(mocks.codeMatchCalls).toBe(0);
        const [challenge] = await challengeRowsOf(tx, hostId);
        expect(challenge?.failedAttempts).toBe(5);
        expect(await organizationEmailRowsOf(tx, hostId)).toEqual([]);
      });
    });

    it("refuses an expired code without counting it", async () => {
      await inRollback(async (tx) => {
        const hostId = await signUpHost(tx, "rina.free@gmail.com");
        await issue(tx, hostId, "rina@acme.example");
        // Planted directly: a stand-in for the clock, which a rolled-back test cannot move.
        await tx
          .update(schema.organizationEmailChallenges)
          .set({ expiresAt: sql`now() - interval '1 second'` })
          .where(eq(schema.organizationEmailChallenges.userId, hostId));

        const refusal = await refusalOf(
          confirm(tx, hostId, latestOrganizationCodeFor("rina@acme.example")),
        );

        expect(refusal.code).toBe("organization_email_code_expired");
        const [challenge] = await challengeRowsOf(tx, hostId);
        expect(challenge?.failedAttempts).toBe(0);
        expect(await organizationEmailRowsOf(tx, hostId)).toEqual([]);
      });
    });

    it("refuses a code that was already used", async () => {
      await inRollback(async (tx) => {
        const hostId = await signUpHost(tx, "rina.free@gmail.com");
        await issue(tx, hostId, "rina@acme.example");
        const right = latestOrganizationCodeFor("rina@acme.example");
        await confirm(tx, hostId, right);

        const refusal = await refusalOf(confirm(tx, hostId, right));

        expect(refusal.code).toBe("organization_email_no_code");
        expect(refusal.status).toBe(404);
      });
    });

    it("never reads another account's challenge", async () => {
      await inRollback(async (tx) => {
        const hostId = await signUpHost(tx, "rina.free@gmail.com");
        const otherId = await signUpParticipant(tx, "dina@acme.example");
        await issue(tx, hostId, "rina@acme.example");

        const refusal = await refusalOf(
          confirm(tx, otherId, latestOrganizationCodeFor("rina@acme.example")),
        );

        expect(refusal.code).toBe("organization_email_no_code");
        const [challenge] = await challengeRowsOf(tx, hostId);
        expect(challenge?.failedAttempts).toBe(0);
        expect(challenge?.consumedAt).toBeNull();
        expect(await organizationEmailRowsOf(tx, otherId)).toEqual([]);
      });
    });

    it("refuses an address that is another account's sign-in email", async () => {
      await inRollback(async (tx) => {
        await signUpParticipant(tx, "dina@acme.example");
        const hostId = await signUpHost(tx, "rina.free@gmail.com");
        await issue(tx, hostId, "dina@acme.example");

        const refusal = await refusalOf(
          confirm(tx, hostId, latestOrganizationCodeFor("dina@acme.example")),
        );

        expect(refusal.code).toBe("organization_email_taken");
        expect(refusal.status).toBe(409);
        expect(await organizationEmailRowsOf(tx, hostId)).toEqual([]);
        expect(await tierOf(tx, hostId)).toBe("minimal");
        const [challenge] = await challengeRowsOf(tx, hostId);
        expect(challenge?.consumedAt).toBeNull();
      });
    });

    it("refuses an address that is another account's Email organisasi", async () => {
      await inRollback(async (tx) => {
        const participantId = await signUpParticipant(tx, "rina.peserta@acme.example");
        await issue(tx, participantId, "budi@acme.example");
        await confirm(tx, participantId, latestOrganizationCodeFor("budi@acme.example"));
        const hostId = await signUpHost(tx, "rina.free@gmail.com");
        await issue(tx, hostId, "budi@acme.example");

        const refusal = await refusalOf(
          confirm(tx, hostId, latestOrganizationCodeFor("budi@acme.example")),
        );

        expect(refusal.code).toBe("organization_email_taken");
        expect(await organizationEmailRowsOf(tx, participantId)).toEqual([
          { email: "budi@acme.example", domain: "acme.example" },
        ]);
        expect(await organizationEmailRowsOf(tx, hostId)).toEqual([]);
        expect(await tierOf(tx, hostId)).toBe("minimal");
      });
    });

    it("replaces the account's earlier Email organisasi", async () => {
      await inRollback(async (tx) => {
        const participantId = await signUpParticipant(tx, "rina.peserta@acme.example");
        await issue(tx, participantId, "budi@acme.example");
        await confirm(tx, participantId, latestOrganizationCodeFor("budi@acme.example"));

        await issue(tx, participantId, "dina.panitia@acme.example");
        await confirm(tx, participantId, latestOrganizationCodeFor("dina.panitia@acme.example"));

        expect(await organizationEmailRowsOf(tx, participantId)).toEqual([
          { email: "dina.panitia@acme.example", domain: "acme.example" },
        ]);
      });
    });

    it("counts at most 50 tries per domain across accounts and refuses the next one uncompared", async () => {
      await inRollback(async (tx) => {
        const accounts: string[] = [];
        for (let k = 1; k <= 11; k += 1) {
          const account = await signUpParticipant(tx, `peserta.${k}@acme.example`);
          await issue(tx, account, `staff.${k}@kampus.example`);
          accounts.push(account);
        }

        for (let k = 1; k <= 10; k += 1) {
          const wrong = wrongCodeFor(latestOrganizationCodeFor(`staff.${k}@kampus.example`));
          for (let attempt = 1; attempt <= 5; attempt += 1) {
            const refusal = await refusalOf(confirm(tx, accounts[k - 1]!, wrong));
            expect(refusal.code).toBe("organization_email_code_invalid");
          }
        }
        mocks.codeMatchCalls = 0;

        const refusal = await refusalOf(
          confirm(tx, accounts[10]!, latestOrganizationCodeFor("staff.11@kampus.example")),
        );

        expect(refusal.code).toBe("organization_email_code_locked");
        expect(refusal.message).toBe(
          "Terlalu banyak percobaan kode untuk domain email ini hari ini. Coba lagi besok.",
        );
        const [challenge] = await challengeRowsOf(tx, accounts[10]!);
        expect(challenge?.failedAttempts).toBe(1);
        expect(mocks.codeMatchCalls).toBe(0);
        expect(await organizationEmailRowsOf(tx, accounts[10]!)).toEqual([]);
      });
    }, 120_000);

    it("refuses a try when the domain count cannot be read", async () => {
      await inRollback(async (tx) => {
        const account = await signUpParticipant(tx, "peserta.1@acme.example");
        await issue(tx, account, "staff.1@kampus.example");
        mocks.limiterUnavailable = true;
        mocks.codeMatchCalls = 0;

        const refusal = await refusalOf(
          confirm(tx, account, latestOrganizationCodeFor("staff.1@kampus.example")),
        );

        expect(refusal.code).toBe("organization_email_code_locked");
        expect(refusal.message).toBe(
          "Kode belum dapat diperiksa saat ini. Tunggu beberapa menit sebelum mencoba lagi, atau minta kode baru.",
        );
        const [challenge] = await challengeRowsOf(tx, account);
        expect(challenge?.failedAttempts).toBe(1);
        expect(mocks.codeMatchCalls).toBe(0);
        expect(await organizationEmailRowsOf(tx, account)).toEqual([]);
      });
    });

    it("counts tries on two subdomains of one organization against one cap", async () => {
      await inRollback(async (tx) => {
        const accounts: string[] = [];
        for (let k = 1; k <= 11; k += 1) {
          accounts.push(await signUpParticipant(tx, `peserta.${k}@acme.example`));
        }
        for (let k = 1; k <= 5; k += 1) {
          await issue(tx, accounts[k - 1]!, `staff.${k}@teknik.kampus.example`);
        }
        for (let k = 6; k <= 10; k += 1) {
          await issue(tx, accounts[k - 1]!, `staff.${k}@hukum.kampus.example`);
        }
        await issue(tx, accounts[10]!, "staff.11@ekonomi.kampus.example");

        for (let k = 1; k <= 10; k += 1) {
          const address =
            k <= 5 ? `staff.${k}@teknik.kampus.example` : `staff.${k}@hukum.kampus.example`;
          const wrong = wrongCodeFor(latestOrganizationCodeFor(address));
          for (let attempt = 1; attempt <= 5; attempt += 1) {
            const refusal = await refusalOf(confirm(tx, accounts[k - 1]!, wrong));
            expect(refusal.code).toBe("organization_email_code_invalid");
          }
        }
        mocks.codeMatchCalls = 0;

        const refusal = await refusalOf(
          confirm(tx, accounts[10]!, latestOrganizationCodeFor("staff.11@ekonomi.kampus.example")),
        );

        expect(refusal.code).toBe("organization_email_code_locked");
        expect(refusal.message).toBe(
          "Terlalu banyak percobaan kode untuk domain email ini hari ini. Coba lagi besok.",
        );
        const [challenge] = await challengeRowsOf(tx, accounts[10]!);
        expect(challenge?.failedAttempts).toBe(1);
        expect(mocks.codeMatchCalls).toBe(0);
        expect(await organizationEmailRowsOf(tx, accounts[10]!)).toEqual([]);
      });
    }, 120_000);

    it("spends no domain try on confirms that cannot be claimed", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpParticipant(tx, "peserta.1@acme.example");
        await issue(tx, accountA, "staff.1@kampus.example");
        // Planted directly: a stand-in for the clock, which a rolled-back test cannot move.
        await tx
          .update(schema.organizationEmailChallenges)
          .set({ expiresAt: sql`now() - interval '1 second'` })
          .where(eq(schema.organizationEmailChallenges.userId, accountA));
        const wrong = wrongCodeFor(latestOrganizationCodeFor("staff.1@kampus.example"));

        for (let attempt = 1; attempt <= 50; attempt += 1) {
          const refusal = await refusalOf(confirm(tx, accountA, wrong));
          expect(refusal.code).toBe("organization_email_code_expired");
        }

        expect(mocks.windowCounts.get("rl:org-email-domain-try:kampus.example")).toBeUndefined();
        const accountB = await signUpParticipant(tx, "peserta.2@acme.example");
        await issue(tx, accountB, "staff.2@kampus.example");
        const confirmed = await confirm(
          tx,
          accountB,
          latestOrganizationCodeFor("staff.2@kampus.example"),
        );
        expect(confirmed).toEqual({ email: "staff.2@kampus.example", trustSource: null });
      });
    }, 120_000);

    it("spends no domain try on confirms of a locked challenge", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpParticipant(tx, "peserta.1@acme.example");
        await issue(tx, accountA, "staff.1@kampus.example");
        const wrong = wrongCodeFor(latestOrganizationCodeFor("staff.1@kampus.example"));
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const refusal = await refusalOf(confirm(tx, accountA, wrong));
          expect(refusal.code).toBe("organization_email_code_invalid");
        }

        for (let attempt = 1; attempt <= 10; attempt += 1) {
          const refusal = await refusalOf(confirm(tx, accountA, wrong));
          expect(refusal.code).toBe("organization_email_code_locked");
        }

        expect(mocks.windowCounts.get("rl:org-email-domain-try:kampus.example")).toBe(5);
        const accountB = await signUpParticipant(tx, "peserta.2@acme.example");
        await issue(tx, accountB, "staff.2@kampus.example");
        const confirmed = await confirm(
          tx,
          accountB,
          latestOrganizationCodeFor("staff.2@kampus.example"),
        );
        expect(confirmed).toEqual({ email: "staff.2@kampus.example", trustSource: null });
      });
    });

    it("gives no trust to a host whose trust staff removed when it confirms through the route", async () => {
      await inRollback(async (tx) => {
        const hostId = await signUpHost(tx, "rina.free@gmail.com");
        // Planted directly: stands in for the staff trust removal, which this file does not drive.
        await tx
          .update(schema.users)
          .set({ hostTrustRemovedAt: new Date() })
          .where(eq(schema.users.id, hostId));
        await issue(tx, hostId, "rina@acme.example");
        mocks.routeTransaction = tx;
        mocks.routeSession = {
          user: {
            id: hostId,
            email: "rina.free@gmail.com",
            role: "recruiter",
            verifiedRoles: ["candidate", "recruiter"],
          },
          expires: new Date(Date.now() + 60_000).toISOString(),
        } as Session;

        const response = await confirmRoute(
          new Request("http://localhost/api/v1/me/organization-email/confirm", {
            method: "POST",
            headers: { "content-type": "application/json", [SESSION_USER_HEADER]: hostId },
            body: JSON.stringify({ code: latestOrganizationCodeFor("rina@acme.example") }),
          }) as unknown as Parameters<typeof confirmRoute>[0],
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          organizationEmail: { email: "rina@acme.example", trustSource: null },
        });
        expect(await tierOf(tx, hostId)).toBe("minimal");
        expect(await organizationEmailRowsOf(tx, hostId)).toEqual([
          { email: "rina@acme.example", domain: "acme.example" },
        ]);
      });
    });
  });

  describe("account deletion", () => {
    it("frees the Email organisasi of a deleted account for a new account", async () => {
      await inRollback(async (tx) => {
        const accountA = await signUpParticipant(tx, "rina.peserta@acme.example");
        await issue(tx, accountA, "budi@acme.example");
        await confirm(tx, accountA, latestOrganizationCodeFor("budi@acme.example"));
        await issue(tx, accountA, "dina.panitia@acme.example");
        const operator = await seedOperator(tx);
        const username = await usernameOf(tx, accountA);

        await deidentifyAccount(
          operator,
          accountA,
          { confirmUsername: username, reason: "permintaan pemilik akun" },
          tx,
        );

        expect(await organizationEmailRowsOf(tx, accountA)).toEqual([]);
        expect(await challengeRowsOf(tx, accountA)).toEqual([]);
        const accountB = await signUpParticipant(tx, "rina.baru@acme.example");
        await issue(tx, accountB, "budi@acme.example");
        await confirm(tx, accountB, latestOrganizationCodeFor("budi@acme.example"));
        expect(await organizationEmailRowsOf(tx, accountB)).toEqual([
          { email: "budi@acme.example", domain: "acme.example" },
        ]);
      });
    });
  });
});

const MARKER = "orgemailrace";

const BARRIER_TIMEOUT_MS = 5_000;
const BARRIER_POLL_MS = 5;

type Connection = {
  label: string;
  sql: postgres.Sql;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

const openConnection = (label: string): Connection => {
  const connection = postgres(TEST_DATABASE_URL!, {
    // One connection per racer, and never recycled: a racer's queries must land on the backend whose
    // pid was captured, because that pid is what the wait graph is read against.
    max: 1,
    idle_timeout: 0,
  });

  return { label, sql: connection, db: drizzle(connection, { schema }) };
};

let control: Connection;
let barrier: Connection;

const backendPidOf = async (connection: Connection): Promise<number> => {
  const rows = await connection.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  return Number(rows[0]!.pid);
};

/**
 * Everything `waiterPid` is waiting on, transitively. Postgres queues the second waiter behind the
 * first, so a direct-membership check would read a correctly formed queue as no queue at all.
 */
const transitiveBlockersOf = async (waiterPid: number): Promise<number[]> => {
  const rows = await control.sql<{ pid: number }[]>`
    with recursive chain(pid) as (
      select unnest(pg_blocking_pids(${waiterPid}))
      union
      select unnest(pg_blocking_pids(chain.pid)) from chain
    )
    select pid from chain`;

  return rows.map((row) => Number(row.pid));
};

/** Waits until `waiter` is queued behind `holder`, reading Postgres's own wait graph. */
const awaitBlockedBy = async (
  waiterPid: number,
  holderPid: number,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  let lastSeen: number[] = [];

  while (Date.now() < deadline) {
    lastSeen = await transitiveBlockersOf(waiterPid);

    if (lastSeen.includes(holderPid)) return;

    await new Promise((resolve) => setTimeout(resolve, BARRIER_POLL_MS));
  }

  throw new Error(
    `${what} never queued behind the lock this test holds. The transitive blockers of ` +
      `${waiterPid} were last [${lastSeen.join(", ")}] and never included the holder ${holderPid}.\n` +
      `THIS IS THE GUARD-REMOVAL SIGNAL, NOT A FLAKE. The operation is expected to take that lock ` +
      `and queue behind whoever holds it. If this started failing after a change to a lock, the ` +
      `lock is what broke. Do NOT raise BARRIER_TIMEOUT_MS to make it pass.`,
  );
};

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Starts a racer immediately and captures its outcome, so a rejection is data rather than noise. */
const settle = <T>(work: Promise<T>): Promise<Settled<T>> =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

/** Launches a racer and keeps it accounted for, so the harness can wait it out before tearing down. */
type TrackRacer = <T>(work: Promise<T>) => Promise<Settled<T>>;

/**
 * Holds what `takeHold` takes, a lock or an uncommitted row, in one barrier transaction for the
 * duration of `body`, and ALWAYS gives it back by committing.
 *
 * The `finally` is the only reason this suite can report a failure at all: a barrier left holding
 * the lock would make the teardown wait on it forever. Racers launched through `track` are awaited
 * there too, so none wakes up during teardown and commits rows into the middle of the sweep.
 */
const holdInBarrierTransaction = async <T>(
  takeHold: (tx: postgres.TransactionSql) => Promise<unknown>,
  body: (track: TrackRacer) => Promise<T>,
): Promise<T> => {
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => (markAcquired = resolve));
  let allowRelease!: () => void;
  const released = new Promise<void>((resolve) => (allowRelease = resolve));

  const holding = barrier.sql.begin(async (tx) => {
    await takeHold(tx);
    markAcquired();
    await released;
  });

  await Promise.race([
    acquired,
    holding.then(() => {
      throw new Error("the barrier transaction ended before it took its hold");
    }),
  ]);

  const inFlight: Promise<unknown>[] = [];
  const track: TrackRacer = (work) => {
    const settled = settle(work);
    inFlight.push(settled);
    return settled;
  };

  try {
    return await body(track);
  } finally {
    allowRelease();
    await holding.catch(() => undefined);
    await Promise.all(inFlight);
  }
};

/**
 * Holds one advisory lock on the barrier connection for the duration of `body`.
 *
 * The key is rebuilt by each test rather than imported, so the test states the string it expects
 * the service to take. A namespace change on one side and not the other has to show up as a test
 * that stops blocking, not as two constants silently agreeing to differ.
 */
const holdAdvisoryLock = <T>(
  lockKey: string,
  body: (track: TrackRacer) => Promise<T>,
): Promise<T> =>
  holdInBarrierTransaction(
    (tx) => tx.unsafe("select pg_advisory_xact_lock(hashtext($1))", [lockKey]),
    body,
  );

const errorCodeOf = (error: unknown): string | undefined =>
  (error as { code?: string } | undefined)?.code;

let seedCounter = 0;
const nextSeedId = (): string => `${Date.now().toString(36)}${seedCounter++}`;

const seedRaceAccount = async (label: string): Promise<string> => {
  const username = `${MARKER}_${label}_${nextSeedId()}`;
  const [row] = await control.db
    .insert(schema.users)
    .values({
      email: `${username}@example.test`,
      username,
      emailVerified: new Date(),
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  return row!.id;
};

/**
 * Deletes every account any run of this file has created, matched by marker so it also removes what
 * a crashed run left behind. Their challenge rows go with them by the foreign key.
 */
const sweepRaceRows = async (): Promise<void> => {
  await control.sql`delete from users where username like ${`${MARKER}_%`}`;
};

const countChallengeRowsOf = async (userId: string): Promise<number> => {
  const rows = await control.sql<{ count: string }[]>`
    select count(*) as count from organization_email_challenges where user_id = ${userId}`;
  return Number(rows[0]!.count);
};

const challengeIdOf = async (userId: string): Promise<string> => {
  const rows = await control.sql<{ id: string }[]>`
    select id from organization_email_challenges where user_id = ${userId}`;
  return rows[0]!.id;
};

const organizationEmailsOf = async (userId: string): Promise<string[]> => {
  const rows = await control.sql<{ email: string }[]>`
    select email from host_organization_emails where user_id = ${userId} order by email`;
  return rows.map((row) => row.email);
};

const countChallengeRowsForAddress = async (address: string): Promise<number> => {
  const rows = await control.sql<{ count: string }[]>`
    select count(*) as count from organization_email_challenges where email = ${address}`;
  return Number(rows[0]!.count);
};

const failedAttemptsOf = async (userId: string): Promise<number> => {
  const rows = await control.sql<{ failed_attempts: number }[]>`
    select failed_attempts from organization_email_challenges where user_id = ${userId}`;
  return Number(rows[0]!.failed_attempts);
};

const asDatabase = (connection: Connection): Database => connection.db as unknown as Database;

const purgeOnSignal = () => {
  void sweepRaceRows().catch(() => undefined);
};

describe.skipIf(skipWithoutDatabase)(
  "Email organisasi code under concurrent requests (committed rows)",
  () => {
    beforeAll(async () => {
      control = openConnection("control");
      barrier = openConnection("barrier");

      // A sweep that WAITS on a stray lock hangs with no message. A bounded wait names it instead.
      await control.sql.unsafe("set lock_timeout = '10s'");

      await sweepRaceRows();

      process.on("SIGINT", purgeOnSignal);
      process.on("SIGTERM", purgeOnSignal);
    });

    afterEach(async () => {
      // In afterEach so an assertion failing mid-test cannot skip the cleanup of committed rows.
      await sweepRaceRows();
    });

    afterAll(async () => {
      process.off("SIGINT", purgeOnSignal);
      process.off("SIGTERM", purgeOnSignal);

      try {
        await sweepRaceRows();

        const users = await control.sql<{ count: string }[]>`
          select count(*) as count from users where username like ${`${MARKER}_%`}`;
        const challenges = await control.sql<{ count: string }[]>`
          select count(*) as count from organization_email_challenges
          where email like ${"%@kampus.example"}`;
        const organizationEmails = await control.sql<{ count: string }[]>`
          select count(*) as count from host_organization_emails
          where email like ${"%@kampus.example"}`;

        expect(Number(users[0]!.count), "race accounts left behind").toBe(0);
        expect(Number(challenges[0]!.count), "race challenge rows left behind").toBe(0);
        expect(
          Number(organizationEmails[0]!.count),
          "race organization email rows left behind",
        ).toBe(0);
      } finally {
        // Connections close whether or not the survivor assertions passed.
        await Promise.all([control?.sql.end(), barrier?.sql.end()]);
      }
    });

    it("lets exactly five of eight concurrent sends to one address through", async () => {
      const accounts: string[] = [];
      for (let k = 1; k <= 8; k += 1) accounts.push(await seedRaceAccount(`send${k}`));
      const racers = accounts.map((_, k) => openConnection(`racer-${k + 1}`));

      try {
        const pids = await Promise.all(racers.map(backendPidOf));
        const barrierPid = await backendPidOf(barrier);

        const outcomes = await holdAdvisoryLock(
          "org_email_send_email:panitia@kampus.example",
          async (track) => {
            const running = racers.map((racer, k) =>
              track(
                issueOrganizationEmailCode(
                  accounts[k]!,
                  "panitia@kampus.example",
                  asDatabase(racer),
                ),
              ),
            );
            for (const [k, pid] of pids.entries()) {
              await awaitBlockedBy(pid, barrierPid, `racer ${k + 1}`);
            }
            return running;
          },
        );
        const settled = await Promise.all(outcomes);

        expect(settled.filter((outcome) => outcome.ok)).toHaveLength(5);
        const refused = settled.filter((outcome) => !outcome.ok);
        expect(refused).toHaveLength(3);
        for (const outcome of refused) {
          expect(errorCodeOf(!outcome.ok ? outcome.error : undefined)).toBe(
            "organization_email_daily_limit",
          );
        }
        expect(await countChallengeRowsForAddress("panitia@kampus.example")).toBe(5);
      } finally {
        await Promise.all(racers.map((racer) => racer.sql.end()));
      }
    }, 60_000);

    it("lets exactly ten of twelve concurrent sends from one account through", async () => {
      const account = await seedRaceAccount("sender");
      const racers = Array.from({ length: 12 }, (_, k) => openConnection(`racer-${k + 1}`));

      try {
        const pids = await Promise.all(racers.map(backendPidOf));
        const barrierPid = await backendPidOf(barrier);

        const outcomes = await holdAdvisoryLock(
          `org_email_send_account:${account}`,
          async (track) => {
            const running = racers.map((racer, k) =>
              track(
                issueOrganizationEmailCode(
                  account,
                  `panitia.${k + 1}@kampus.example`,
                  asDatabase(racer),
                ),
              ),
            );
            for (const [k, pid] of pids.entries()) {
              await awaitBlockedBy(pid, barrierPid, `racer ${k + 1}`);
            }
            return running;
          },
        );
        const settled = await Promise.all(outcomes);

        expect(settled.filter((outcome) => outcome.ok)).toHaveLength(10);
        const refused = settled.filter((outcome) => !outcome.ok);
        expect(refused).toHaveLength(2);
        for (const outcome of refused) {
          expect(errorCodeOf(!outcome.ok ? outcome.error : undefined)).toBe(
            "organization_email_daily_limit",
          );
        }
        expect(await countChallengeRowsOf(account)).toBe(10);
      } finally {
        await Promise.all(racers.map((racer) => racer.sql.end()));
      }
    }, 60_000);

    it("claims at most five tries when twenty wrong codes arrive at once", async () => {
      const account = await seedRaceAccount("guesser");
      await issueOrganizationEmailCode(account, "bendahara@kampus.example", asDatabase(control));
      const right = latestOrganizationCodeFor("bendahara@kampus.example");
      const wrong = wrongCodeFor(right);
      const pool = postgres(TEST_DATABASE_URL!, { max: 5 });

      try {
        const poolDb = drizzle(pool, { schema }) as unknown as Database;
        mocks.codeMatchCalls = 0;

        const running = Array.from({ length: 20 }, () =>
          settle(confirmOrganizationEmailCode(account, wrong, poolDb)),
        );
        const settled = await Promise.all(running);

        const refusals = settled.map((outcome) => {
          if (outcome.ok) throw new Error("A wrong code was accepted");
          return outcome.error as OrganizationEmailError;
        });
        const invalid = refusals.filter(
          (error) => error.code === "organization_email_code_invalid",
        );
        const locked = refusals.filter((error) => error.code === "organization_email_code_locked");
        expect(invalid).toHaveLength(5);
        expect(locked).toHaveLength(15);
        const attemptsLeft = invalid.map((error) => error.details?.attemptsLeft);
        expect([...attemptsLeft].sort()).toEqual([0, 1, 2, 3, 4]);
        expect(mocks.codeMatchCalls).toBe(5);
        expect(await failedAttemptsOf(account)).toBe(5);

        mocks.codeMatchCalls = 0;
        const refusal = await refusalOf(confirmOrganizationEmailCode(account, right, poolDb));

        expect(refusal.code).toBe("organization_email_code_locked");
        expect(mocks.codeMatchCalls).toBe(0);
        expect(await failedAttemptsOf(account)).toBe(5);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("spends at most five domain tries when twenty wrong codes arrive at once on one challenge", async () => {
      const account = await seedRaceAccount("spender");
      await issueOrganizationEmailCode(account, "sekretaris@kampus.example", asDatabase(control));
      const wrong = wrongCodeFor(latestOrganizationCodeFor("sekretaris@kampus.example"));
      const pool = postgres(TEST_DATABASE_URL!, { max: 5 });

      try {
        const poolDb = drizzle(pool, { schema }) as unknown as Database;
        mocks.codeMatchCalls = 0;

        const running = Array.from({ length: 20 }, () =>
          settle(confirmOrganizationEmailCode(account, wrong, poolDb)),
        );
        const settled = await Promise.all(running);

        expect(settled.filter((outcome) => outcome.ok)).toHaveLength(0);
        expect(mocks.windowCounts.get("rl:org-email-domain-try:kampus.example")).toBe(5);
        expect(mocks.codeMatchCalls).toBe(5);
        expect(await failedAttemptsOf(account)).toBe(5);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("lets one of two concurrent sends by one account to one address through", async () => {
      const account = await seedRaceAccount("sender");
      const racers = [openConnection("racer-1"), openConnection("racer-2")];

      try {
        const pids = await Promise.all(racers.map(backendPidOf));
        const barrierPid = await backendPidOf(barrier);

        const outcomes = await holdAdvisoryLock(
          `org_email_send_account:${account}`,
          async (track) => {
            const running = racers.map((racer) =>
              track(
                issueOrganizationEmailCode(account, "sekretaris@kampus.example", asDatabase(racer)),
              ),
            );
            for (const [k, pid] of pids.entries()) {
              await awaitBlockedBy(pid, barrierPid, `racer ${k + 1}`);
            }
            return running;
          },
        );
        const settled = await Promise.all(outcomes);

        expect(settled.filter((outcome) => outcome.ok)).toHaveLength(1);
        const refused = settled.filter((outcome) => !outcome.ok);
        expect(refused).toHaveLength(1);
        expect(errorCodeOf(!refused[0]!.ok ? refused[0]!.error : undefined)).toBe(
          "organization_email_resend_too_soon",
        );
        expect(await countChallengeRowsOf(account)).toBe(1);
      } finally {
        await Promise.all(racers.map((racer) => racer.sql.end()));
      }
    }, 60_000);

    it("lets one of two concurrent right codes for one challenge through", async () => {
      const account = await seedRaceAccount("confirmer");
      await issueOrganizationEmailCode(account, "humas@kampus.example", asDatabase(control));
      const right = latestOrganizationCodeFor("humas@kampus.example");
      const challengeId = await challengeIdOf(account);
      const racers = [openConnection("racer-1"), openConnection("racer-2")];

      try {
        const pids = await Promise.all(racers.map(backendPidOf));
        const barrierPid = await backendPidOf(barrier);

        const outcomes = await holdInBarrierTransaction(
          (tx) =>
            tx.unsafe("select id from organization_email_challenges where id = $1 for update", [
              challengeId,
            ]),
          async (track) => {
            const running = racers.map((racer) =>
              track(confirmOrganizationEmailCode(account, right, asDatabase(racer))),
            );
            for (const [k, pid] of pids.entries()) {
              await awaitBlockedBy(pid, barrierPid, `racer ${k + 1}`);
            }
            return running;
          },
        );
        const settled = await Promise.all(outcomes);

        const accepted = settled.filter((outcome) => outcome.ok);
        expect(accepted).toHaveLength(1);
        expect(accepted[0]!.ok ? accepted[0]!.value : undefined).toEqual({
          email: "humas@kampus.example",
          trustSource: null,
        });
        const refused = settled.filter((outcome) => !outcome.ok);
        expect(refused).toHaveLength(1);
        expect(errorCodeOf(!refused[0]!.ok ? refused[0]!.error : undefined)).toBe(
          "organization_email_no_code",
        );
        expect(
          await failedAttemptsOf(account),
          "both claims must land before either consume, or the test did not reach the consume statement",
        ).toBe(2);
        expect(await organizationEmailsOf(account)).toEqual(["humas@kampus.example"]);
      } finally {
        await Promise.all(racers.map((racer) => racer.sql.end()));
      }
    }, 60_000);

    it("refuses a confirm whose address another account records while it runs, and keeps its earlier row", async () => {
      const holder = await seedRaceAccount("holder");
      const taker = await seedRaceAccount("taker");
      await issueOrganizationEmailCode(holder, "lama@kampus.example", asDatabase(control));
      await confirmOrganizationEmailCode(
        holder,
        latestOrganizationCodeFor("lama@kampus.example"),
        asDatabase(control),
      );
      await issueOrganizationEmailCode(holder, "sekretariat@kampus.example", asDatabase(control));
      const right = latestOrganizationCodeFor("sekretariat@kampus.example");
      const racer = openConnection("racer-1");

      try {
        const racerPid = await backendPidOf(racer);
        const barrierPid = await backendPidOf(barrier);

        const outcomes = await holdInBarrierTransaction(
          (tx) =>
            tx.unsafe(
              `insert into host_organization_emails (user_id, email, domain, confirmed_at)
               values ($1, 'sekretariat@kampus.example', 'kampus.example', now())`,
              [taker],
            ),
          async (track) => {
            const running = track(confirmOrganizationEmailCode(holder, right, asDatabase(racer)));
            await awaitBlockedBy(racerPid, barrierPid, "racer 1");
            return [running];
          },
        );
        const [outcome] = await Promise.all(outcomes);

        expect(outcome!.ok).toBe(false);
        expect(errorCodeOf(!outcome!.ok ? outcome!.error : undefined)).toBe(
          "organization_email_taken",
        );
        expect(await organizationEmailsOf(holder)).toEqual(["lama@kampus.example"]);
        expect(await organizationEmailsOf(taker)).toEqual(["sekretariat@kampus.example"]);
      } finally {
        await racer.sql.end();
      }
    }, 60_000);
  },
);
