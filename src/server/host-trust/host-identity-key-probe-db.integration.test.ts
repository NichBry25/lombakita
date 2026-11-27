// @vitest-environment node

// The deploy gate's host identity key probe against real rows in a rolled-back transaction. Hosts
// come through the real sign-up, code verification and host step services, their Email organisasi
// through its real code services, their removal through the removal service and their record through
// the record writer. A row is planted directly only where this file does not drive its writer, and
// each such helper says so.

import { TransactionRollbackError, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const hostKeys = vi.hoisted(() => ({
  one: Buffer.alloc(32, 11).toString("base64"),
  two: Buffer.alloc(32, 22).toString("base64"),
  short: Buffer.alloc(16, 1).toString("base64"),
  authSecret: Buffer.alloc(32, 33).toString("base64"),
}));

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  organizationCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
  enqueueRemoved: vi.fn(async (_input: unknown) => ({})),
  enqueueApproved: vi.fn(async (_input: unknown) => ({})),
}));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: {
      ...actual.serverEnv,
      authSecret: hostKeys.authSecret,
      hostIdentityHashKey: hostKeys.one,
    },
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
      const count = (mocks.windowCounts.get(params.key) ?? 0) + 1;
      mocks.windowCounts.set(params.key, count);
      if (count > params.limit) {
        return { decision: "throttled" as const, retryAfterSeconds: params.windowSeconds };
      }
      return { decision: "allowed" as const };
    },
  };
});

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return {
    ...actual,
    enqueueCompetitionSearchSync: vi.fn(async () => ({})),
    enqueueCompetitionCancelled: vi.fn(async () => ({})),
    enqueueCompetitionEdited: vi.fn(async () => ({})),
    enqueueRegistrationConfirmed: vi.fn(async () => ({})),
    enqueueInstitutionInvitationDispatch: vi.fn(async () => ({})),
    enqueueRecruiterVerificationApproved: mocks.enqueueApproved,
    enqueueHostTrustRemoved: mocks.enqueueRemoved,
  };
});

import { serverEnv } from "@/config/env.server";
import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import {
  assertTrustRemovalRecordsUseLiveKey,
  isHostIdentityKeyConfigured,
} from "./host-identity-key-probe";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "./organization-email-service";
import { removeHostTrust } from "./host-trust-removal-service";
import {
  HostIdentityKeyError,
  hostIdentityKeyCheck,
  recordRemovedHostIdentity,
} from "./removed-host-identity";

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

const useHostIdentityKey = (value: string | undefined) => {
  (serverEnv as { hostIdentityHashKey?: string }).hostIdentityHashKey = value;
};

beforeEach(() => {
  mocks.sentCodes.length = 0;
  mocks.organizationCodes.length = 0;
  mocks.windowCounts.clear();
  mocks.enqueueRemoved.mockClear();
  mocks.enqueueApproved.mockClear();
  useHostIdentityKey(hostKeys.one);
});

const latestCode = (): string => {
  const sent = mocks.sentCodes.at(-1);
  if (!sent) throw new Error("No code was sent");
  return sent.code;
};

const userIdOfAddress = async (tx: Database, address: string): Promise<string> => {
  const [row] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, address));
  if (!row) throw new Error("No user row");
  return row.id;
};

const signUpParticipant = async (
  tx: Database,
  address: string,
  phoneNumber: string,
): Promise<string> => {
  await registerUserWithCredentials(
    { ...CANDIDATE_DETAILS, phoneNumber, email: address, password: PASSWORD },
    tx,
  );
  await verifyEmailCodeAndSetPassword(
    { ...CANDIDATE_DETAILS, phoneNumber, email: address, code: latestCode(), password: PASSWORD },
    tx,
  );
  return userIdOfAddress(tx, address);
};

const signUpHost = async (tx: Database, address: string, phoneNumber: string): Promise<string> => {
  const userId = await signUpParticipant(tx, address, phoneNumber);
  await markRoleAsVerified(userId, "recruiter", null, tx);
  return userId;
};

const latestOrganizationCode = (): string => {
  const sent = mocks.organizationCodes.at(-1);
  if (!sent) throw new Error("No Email organisasi code was sent");
  return sent.code;
};

const trustByOrganizationEmail = async (
  tx: Database,
  userId: string,
  address: string,
): Promise<void> => {
  await issueOrganizationEmailCode(userId, address, tx);
  await confirmOrganizationEmailCode(userId, latestOrganizationCode(), tx);
};

const REASON = "Kontak palsu di beberapa kompetisi.";

const removeTrust = async (tx: Database, operatorId: string, userId: string): Promise<void> => {
  await removeHostTrust(operatorId, userId, REASON, tx);
};

// Planted directly: a stand-in for the operator promotion, which this file does not drive.
const plantOperator = async (tx: Database, address: string): Promise<string> => {
  const userId = await signUpParticipant(tx, address, "0831-0000-1111");
  await tx.update(schema.users).set({ role: "platform_ops" }).where(eq(schema.users.id, userId));
  return userId;
};

// Planted directly: inside one test transaction a removal and a record share one clock, so the
// removal is moved back to tell them apart, or to stand in for an old removal no path writes.
const backdateRemoval = async (tx: Database, userId: string, interval: string): Promise<void> => {
  await tx
    .update(schema.users)
    .set({ hostTrustRemovedAt: sql`now() - ${interval}::interval` })
    .where(eq(schema.users.id, userId));
};

// Planted directly: the committed records of the local database, written under another key or by a
// hand test, are removed inside the rolled-back transaction so they cannot change an answer.
const clearRecordsInsideRollback = async (tx: Database): Promise<void> => {
  await tx.delete(schema.hostTrustRemovals);
};

const refusalOf = async (pending: Promise<unknown>): Promise<HostIdentityKeyError> => {
  const error = await pending.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HostIdentityKeyError);
  return error as HostIdentityKeyError;
};

const R_ADDRESS = "rudi.host@seed.lombakita.local";
const OPERATOR_ADDRESS = "ops.staf@seed.lombakita.local";

const removeAndRecordRudi = async (tx: Database, operator: string): Promise<string> => {
  const rudi = await signUpHost(tx, R_ADDRESS, "0812-3456-7890");
  await trustByOrganizationEmail(tx, rudi, "Rudi+Lomba@Acme.example");
  await removeTrust(tx, operator, rudi);
  await recordRemovedHostIdentity(tx, rudi);
  return rudi;
};

const removeAndRecordSari = async (tx: Database, operator: string): Promise<string> => {
  const sari = await signUpHost(tx, "sari.host@seed.lombakita.local", "0822-1111-3333");
  await trustByOrganizationEmail(tx, sari, "sari@beta.example");
  await removeTrust(tx, operator, sari);
  await recordRemovedHostIdentity(tx, sari);
  return sari;
};

describe.skipIf(skipWithoutDatabase)("the host identity key probe against a real database", () => {
  it("counts the key as configured only when it is set", () => {
    useHostIdentityKey(undefined);
    expect(isHostIdentityKeyConfigured()).toBe(false);

    useHostIdentityKey(hostKeys.one);
    expect(isHostIdentityKeyConfigured()).toBe(true);
  });

  it("passes an empty table under a valid key", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);

      await expect(assertTrustRemovalRecordsUseLiveKey(tx)).resolves.toBeUndefined();
    });
  });

  it("passes when every record was written under the live key", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      await removeAndRecordRudi(tx, operator);
      await removeAndRecordSari(tx, operator);

      await expect(assertTrustRemovalRecordsUseLiveKey(tx)).resolves.toBeUndefined();
    });
  });

  it("refuses a record written under another key, and the refusal names neither key nor any hash", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      await removeAndRecordRudi(tx, operator);
      const checkUnderOne = hostIdentityKeyCheck();
      useHostIdentityKey(hostKeys.two);
      const checkUnderTwo = hostIdentityKeyCheck();

      const refusal = await refusalOf(assertTrustRemovalRecordsUseLiveKey(tx));

      expect(refusal.code).toBe("host_identity_key_changed");
      expect(refusal.message).toBe(
        "A trust removal record was written under another HOST_IDENTITY_HASH_KEY",
      );
      expect(refusal.message).not.toContain(hostKeys.one);
      expect(refusal.message).not.toContain(hostKeys.two);
      expect(refusal.message).not.toContain(checkUnderOne);
      expect(refusal.message).not.toContain(checkUnderTwo);
    });
  });

  it("refuses a missing key even when no record exists", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      useHostIdentityKey(undefined);

      const refusal = await refusalOf(assertTrustRemovalRecordsUseLiveKey(tx));

      expect(refusal.code).toBe("host_identity_key_missing");
    });
  });

  it("refuses a key that does not decode to 32 bytes even when no record exists, and never prints it", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      useHostIdentityKey(hostKeys.short);

      const refusal = await refusalOf(assertTrustRemovalRecordsUseLiveKey(tx));

      expect(refusal.code).toBe("host_identity_key_invalid");
      expect(refusal.message).not.toContain(hostKeys.short);
    });
  });

  it("refuses when any record, not only the newest, was written under another key", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await signUpHost(tx, R_ADDRESS, "0812-3456-7890");
      await trustByOrganizationEmail(tx, rudi, "Rudi+Lomba@Acme.example");
      await removeTrust(tx, operator, rudi);
      await backdateRemoval(tx, rudi, "30 days");
      await recordRemovedHostIdentity(tx, rudi);
      // Trusted before the key changes, because the match of the Email organisasi confirm refuses a
      // record written under another key.
      const sari = await signUpHost(tx, "sari.host@seed.lombakita.local", "0822-1111-3333");
      await trustByOrganizationEmail(tx, sari, "sari@beta.example");
      useHostIdentityKey(hostKeys.two);
      await removeTrust(tx, operator, sari);
      await recordRemovedHostIdentity(tx, sari);

      const refusal = await refusalOf(assertTrustRemovalRecordsUseLiveKey(tx));

      expect(refusal.code).toBe("host_identity_key_changed");
    });
  });
});
