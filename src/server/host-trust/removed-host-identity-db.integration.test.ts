// @vitest-environment node

// The trust removal record against real rows in a rolled-back transaction. Hosts come through the
// real sign-up, code verification and host step services, their Email organisasi through its real
// code services and their removal through the removal service. A row is planted directly only where
// this file does not drive its writer, and each such helper says so.

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

const jobState = vi.hoisted(() => ({ db: null as Database | null }));

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

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return { ...actual, getDb: () => jobState.db ?? actual.getDb() };
});

// No test here uses storage, so the retention job sees it unavailable and runs only the record purge.
vi.mock("@/server/storage/r2.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/storage/r2.client")>();
  return { ...actual, isR2Available: () => false };
});

import { serverEnv } from "@/config/env.server";
import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import { updateCandidateProfile } from "@/server/candidate/candidate-profile-service";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "./organization-email-service";
import { removeHostTrust } from "./host-trust-removal-service";
import {
  HostIdentityKeyError,
  findRemovedHostMatch,
  hashHostIdentifier,
  hostIdentityKeyCheck,
  liftRemovedHostRecord,
  purgeExpiredHostTrustRemovals,
  readHostIdentifiers,
  recordRemovedHostIdentity,
  type HostIdentifierKind,
} from "./removed-host-identity";
import {
  processRetentionPurgeJob,
  type RetentionPurgeJob,
} from "@/server/async/jobs/retention-purge";

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
  jobState.db = null;
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

const trustRemovedAtOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ hostTrustRemovedAt: schema.users.hostTrustRemovedAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.hostTrustRemovedAt;
};

type RequestStatus = (typeof schema.recruiterVerificationSubmissions.$inferInsert)["status"];

// Planted directly: no path writes an older host request any more.
const plantRequest = async (
  tx: Database,
  userId: string,
  mobileNumber: string,
  status: RequestStatus,
  corporateEmail: string | null,
): Promise<void> => {
  await tx.insert(schema.recruiterVerificationSubmissions).values({
    userId,
    fullName: "Rudi Hartono",
    mobileNumber,
    status,
    corporateEmail,
  });
};

// Planted directly: no path writes user_profiles.phone_number.
const plantProfilePhone = async (
  tx: Database,
  userId: string,
  phoneNumber: string,
): Promise<void> => {
  await tx
    .update(schema.userProfiles)
    .set({ phoneNumber })
    .where(eq(schema.userProfiles.userId, userId));
};

// Planted directly: inside one test transaction a removal and a record share one clock, so the
// removal is moved back to tell them apart, or to stand in for an old removal no path writes.
const backdateRemoval = async (tx: Database, userId: string, interval: string): Promise<void> => {
  await tx
    .update(schema.users)
    .set({ hostTrustRemovedAt: sql`now() - ${interval}::interval` })
    .where(eq(schema.users.id, userId));
};

// Planted directly: the writer never writes a record older than 2 years, and it dates a record from
// its account's removal.
const plantRecord = async (
  tx: Database,
  interval: string,
  phoneHashes: string[],
  keyCheck: string,
): Promise<{ id: string; removedAt: Date }> => {
  const [record] = await tx
    .insert(schema.hostTrustRemovals)
    .values({
      userId: null,
      removedAt: sql`now() - ${interval}::interval`,
      phoneHashes,
      keyCheck,
    })
    .returning({ id: schema.hostTrustRemovals.id, removedAt: schema.hostTrustRemovals.removedAt });
  if (!record) throw new Error("No record was planted");
  return record;
};

// Planted directly: the committed records of the local database, written under another key or by a
// hand test, are removed inside the rolled-back transaction so they cannot change an answer.
const clearRecordsInsideRollback = async (tx: Database): Promise<void> => {
  await tx.delete(schema.hostTrustRemovals);
};

const recordsOf = (tx: Database, userId: string) =>
  tx.select().from(schema.hostTrustRemovals).where(eq(schema.hostTrustRemovals.userId, userId));

const removalTimeMatchesAccount = async (tx: Database, userId: string): Promise<boolean> => {
  const [row] = await tx
    .select({
      matches: sql<boolean>`${schema.hostTrustRemovals.removedAt} = ${schema.users.hostTrustRemovedAt}`,
    })
    .from(schema.hostTrustRemovals)
    .innerJoin(schema.users, eq(schema.users.id, schema.hostTrustRemovals.userId))
    .where(eq(schema.hostTrustRemovals.userId, userId));
  return row?.matches ?? false;
};

const hashesOf = (kind: HostIdentifierKind, values: string[]): string[] =>
  values.map((value) => hashHostIdentifier(kind, value)).sort();

const sortedCopy = (values: string[]): string[] => [...values].sort();

const expectKeyError = async (pending: Promise<unknown>, code: string): Promise<void> => {
  const error = await pending.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HostIdentityKeyError);
  expect((error as HostIdentityKeyError).code).toBe(code);
};

const R_ADDRESS = "rudi.host@seed.lombakita.local";
const OPERATOR_ADDRESS = "ops.staf@seed.lombakita.local";

const signUpRudi = (tx: Database) => signUpHost(tx, R_ADDRESS, "0812-3456-7890");

const removeRudi = async (tx: Database, operator: string): Promise<string> => {
  const rudi = await signUpRudi(tx);
  await trustByOrganizationEmail(tx, rudi, "Rudi+Lomba@Acme.example");
  await removeTrust(tx, operator, rudi);
  return rudi;
};

const removeAndRecordRudi = async (tx: Database, operator: string): Promise<string> => {
  const rudi = await removeRudi(tx, operator);
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

describe.skipIf(skipWithoutDatabase)("the trust removal record against a real database", () => {
  it("records a removed host's proven emails, given phones, organization domain and key check, dated from its removal", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await signUpRudi(tx);
      await trustByOrganizationEmail(tx, rudi, "Rudi+Lomba@Acme.example");
      await plantProfilePhone(tx, rudi, "0814-3333-4444");
      await plantRequest(tx, rudi, "0813-1111-2222", "approved", null);
      await removeTrust(tx, operator, rudi);
      await backdateRemoval(tx, rudi, "30 days");

      const wrote = await recordRemovedHostIdentity(tx, rudi);

      expect(wrote).toBe(true);
      const records = await recordsOf(tx, rudi);
      expect(records).toHaveLength(1);
      expect(sortedCopy(records[0]!.emailHashes)).toEqual(
        hashesOf("email", ["rudi.host@seed.lombakita.local", "rudi@acme.example"]),
      );
      expect(sortedCopy(records[0]!.phoneHashes)).toEqual(
        hashesOf("phone", ["6281234567890", "6281311112222", "6281433334444"]),
      );
      expect(records[0]!.organizationDomain).toBe("acme.example");
      expect(records[0]!.keyCheck).toBe(hostIdentityKeyCheck());
      expect(await removalTimeMatchesAccount(tx, rudi)).toBe(true);
    });
  });

  it("reads only what a person proved or gave as their own, and nothing of another account", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const bayu = await signUpHost(tx, "bayu.host@seed.lombakita.local", "0819-0000-1111");
      await trustByOrganizationEmail(tx, bayu, "bayu@other.example");
      await plantProfilePhone(tx, bayu, "0818-2222-3333");
      await plantRequest(tx, bayu, "0817-4444-5555", "approved", null);
      const rudi = await signUpRudi(tx);
      await trustByOrganizationEmail(tx, rudi, "Rudi+Lomba@Acme.example");
      await plantRequest(tx, rudi, "0815-5555-6666", "rejected", "dewi@acme.example");
      await plantRequest(tx, rudi, "0816-7777-8888", "pending_review", null);
      await issueOrganizationEmailCode(rudi, "sari@acme.example", tx);

      const identifiers = await readHostIdentifiers(tx, rudi);

      expect(identifiers).toEqual({
        emails: ["rudi.host@seed.lombakita.local", "rudi@acme.example"],
        phones: ["6281234567890"],
        organizationDomain: "acme.example",
      });
    });
  });

  it("matches a new account by a phone in another form, an Email organisasi without its plus tag, an approved request number and a profile phone", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await removeAndRecordRudi(tx, operator);
      const nina = await signUpHost(tx, "nina.host@seed.lombakita.local", "+62 812 3456 7890");
      const eko = await signUpHost(tx, "eko.host@seed.lombakita.local", "0821-0000-2222");
      await trustByOrganizationEmail(tx, eko, "rudi@acme.example");
      const fajar = await signUpHost(tx, "fajar.host@seed.lombakita.local", "0826-0000-1111");
      await plantRequest(tx, fajar, "0812-3456-7890", "approved", null);
      const gita = await signUpHost(tx, "gita.host@seed.lombakita.local", "0827-0000-1111");
      await plantProfilePhone(tx, gita, "081234567890");

      const removedAt = await trustRemovedAtOf(tx, rudi);

      expect(await findRemovedHostMatch(tx, nina)).toEqual({ matchedBy: ["phone"], removedAt });
      expect(await findRemovedHostMatch(tx, eko)).toEqual({ matchedBy: ["email"], removedAt });
      expect(await findRemovedHostMatch(tx, fajar)).toEqual({ matchedBy: ["phone"], removedAt });
      expect(await findRemovedHostMatch(tx, gita)).toEqual({ matchedBy: ["phone"], removedAt });
    });
  });

  it("names both kinds when one account shares a removed host's email and phone", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await removeAndRecordRudi(tx, operator);
      const wawan = await signUpHost(tx, "rudi@acme.example", "0812 3456 7890");

      const match = await findRemovedHostMatch(tx, wawan);

      expect(match).toEqual({
        matchedBy: ["email", "phone"],
        removedAt: await trustRemovedAtOf(tx, rudi),
      });
    });
  });

  it("reads the organization domain from the Email organisasi first, then from a sign-in email an organization can hold, and never from one it cannot", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const tono = await signUpHost(tx, "tono@mail.other.example", "0824-0000-1111");
      await trustByOrganizationEmail(tx, tono, "tono@acme.example");
      const putri = await signUpParticipant(tx, "putri@mail.acme.example", "0825-0000-1111");
      const qori = await signUpParticipant(tx, "qori@seed.lombakita.local", "0828-0000-1111");

      const tonoIdentifiers = await readHostIdentifiers(tx, tono);
      const putriIdentifiers = await readHostIdentifiers(tx, putri);
      const qoriIdentifiers = await readHostIdentifiers(tx, qori);

      expect(tonoIdentifiers.organizationDomain).toBe("acme.example");
      expect(putriIdentifiers.organizationDomain).toBe("acme.example");
      expect(qoriIdentifiers.organizationDomain).toBeNull();
    });
  });

  it("never matches an account against its own record", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const sari = await removeAndRecordSari(tx, operator);
      const rudi = await removeAndRecordRudi(tx, operator);

      expect(await findRemovedHostMatch(tx, rudi)).toBeNull();
      expect(await findRemovedHostMatch(tx, sari)).toBeNull();
    });
  });

  it("refuses to match under another key than its records were written with, and matches again under that key", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await removeAndRecordRudi(tx, operator);
      const nina = await signUpHost(tx, "nina.host@seed.lombakita.local", "+62 812 3456 7890");
      const removedAt = await trustRemovedAtOf(tx, rudi);

      useHostIdentityKey(hostKeys.two);
      await expectKeyError(findRemovedHostMatch(tx, nina), "host_identity_key_changed");

      useHostIdentityKey(hostKeys.one);
      expect(await findRemovedHostMatch(tx, nina)).toEqual({ matchedBy: ["phone"], removedAt });
    });
  });

  it("refuses to add to a record written under another key and leaves it as it was", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await removeAndRecordRudi(tx, operator);
      const [before] = await recordsOf(tx, rudi);
      const keyCheckBefore = hostIdentityKeyCheck();

      useHostIdentityKey(hostKeys.two);
      await expectKeyError(recordRemovedHostIdentity(tx, rudi), "host_identity_key_changed");

      const after = await recordsOf(tx, rudi);
      expect(after).toHaveLength(1);
      expect(after[0]!.emailHashes).toEqual(before!.emailHashes);
      expect(after[0]!.phoneHashes).toEqual(before!.phoneHashes);
      expect(after[0]!.keyCheck).toBe(keyCheckBefore);
    });
  });

  it("ignores and purges a record older than 2 years and keeps one from a year ago", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      await plantRecord(
        tx,
        "2 years 1 day",
        hashesOf("phone", ["6281234567890"]),
        hostIdentityKeyCheck(),
      );
      const recent = await plantRecord(
        tx,
        "1 year",
        hashesOf("phone", ["6282911113333"]),
        hostIdentityKeyCheck(),
      );
      const nina = await signUpHost(tx, "nina.host@seed.lombakita.local", "0812-3456-7890");
      const maya = await signUpHost(tx, "maya.host@seed.lombakita.local", "0829-1111-3333");

      expect(await findRemovedHostMatch(tx, nina)).toBeNull();
      expect(await findRemovedHostMatch(tx, maya)).toEqual({
        matchedBy: ["phone"],
        removedAt: recent.removedAt,
      });
      expect(await purgeExpiredHostTrustRemovals(tx)).toBe(1);
      const left = await tx
        .select({ id: schema.hostTrustRemovals.id })
        .from(schema.hostTrustRemovals);
      expect(left.map((row) => row.id)).toEqual([recent.id]);
    });
  });

  it("writes no record for a removal older than 2 years or for an account never removed", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await removeRudi(tx, operator);
      await backdateRemoval(tx, rudi, "2 years 1 day");
      // Planted directly: the record the removal wrote goes, as the daily purge deletes it 2 years on.
      await tx.delete(schema.hostTrustRemovals).where(eq(schema.hostTrustRemovals.userId, rudi));
      const putra = await signUpHost(tx, "putra.host@seed.lombakita.local", "0830-0000-1111");

      expect(await recordRemovedHostIdentity(tx, rudi)).toBe(false);
      expect(await recordsOf(tx, rudi)).toEqual([]);
      expect(await recordRemovedHostIdentity(tx, putra)).toBe(false);
      expect(await recordsOf(tx, putra)).toEqual([]);
    });
  });

  it("adds what an account gained after its removal to its record, and keeps the old hashes, the removal time and the first domain", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await removeAndRecordRudi(tx, operator);
      await updateCandidateProfile(rudi, { phoneNumber: "0823-4444-5555" }, tx);
      await trustByOrganizationEmail(tx, rudi, "rudi@baru.example");

      const wrote = await recordRemovedHostIdentity(tx, rudi);

      expect(wrote).toBe(true);
      const records = await recordsOf(tx, rudi);
      expect(records).toHaveLength(1);
      expect(sortedCopy(records[0]!.emailHashes)).toEqual(
        hashesOf("email", [
          "rudi.host@seed.lombakita.local",
          "rudi@acme.example",
          "rudi@baru.example",
        ]),
      );
      expect(sortedCopy(records[0]!.phoneHashes)).toEqual(
        hashesOf("phone", ["6281234567890", "6282344445555"]),
      );
      expect(records[0]!.organizationDomain).toBe("acme.example");
      expect(await removalTimeMatchesAccount(tx, rudi)).toBe(true);
    });
  });

  it("lifts only the named account's record", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const sari = await removeAndRecordSari(tx, operator);
      const rudi = await removeAndRecordRudi(tx, operator);

      await liftRemovedHostRecord(tx, rudi);

      expect(await recordsOf(tx, rudi)).toEqual([]);
      expect(await recordsOf(tx, sari)).toHaveLength(1);
    });
  });

  it("answers no match without the key when no other account's record is from the last 2 years", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      await plantRecord(tx, "2 years 1 day", ["0".repeat(64)], "0".repeat(64));
      const nina = await signUpHost(tx, "nina.host@seed.lombakita.local", "0812-3456-7890");

      useHostIdentityKey(undefined);

      expect(await findRemovedHostMatch(tx, nina)).toBeNull();
    });
  });

  it("matches by email alone an account whose phone gives no dial digits", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await removeAndRecordRudi(tx, operator);
      const wawan = await signUpHost(tx, "rudi@acme.example", "1234-5678");

      const match = await findRemovedHostMatch(tx, wawan);

      expect(match).toEqual({ matchedBy: ["email"], removedAt: await trustRemovedAtOf(tx, rudi) });
    });
  });

  it("the daily retention job deletes the records older than 2 years with storage unavailable, and keeps the one from a year ago", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      await plantRecord(
        tx,
        "2 years 1 day",
        hashesOf("phone", ["6281234567890"]),
        hostIdentityKeyCheck(),
      );
      const recent = await plantRecord(
        tx,
        "1 year",
        hashesOf("phone", ["6282911113333"]),
        hostIdentityKeyCheck(),
      );
      jobState.db = tx;

      const outcome = await processRetentionPurgeJob({
        data: { scheduledFor: "0 3 * * *" },
      } as RetentionPurgeJob);

      expect(outcome).toBeUndefined();
      const left = await tx
        .select({ id: schema.hostTrustRemovals.id })
        .from(schema.hostTrustRemovals);
      expect(left.map((row) => row.id)).toEqual([recent.id]);
    });
  });
});
