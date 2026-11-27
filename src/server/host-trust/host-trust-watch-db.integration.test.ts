// @vitest-environment node

// The staff domain watch against real rows in a rolled-back transaction. Hosts come through the real
// sign-up, code verification and host step services, their Email organisasi through its real code
// services, their removal through the removal service and their suspension through the moderation
// service. A row is planted directly only where this file does not drive its writer, and each such
// helper says so.

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
import { suspendUser } from "@/server/moderation/moderation-service";
import {
  confirmOrganizationEmailCode,
  issueOrganizationEmailCode,
} from "./organization-email-service";
import { removeHostTrust } from "./host-trust-removal-service";
import { recordRemovedHostIdentity } from "./removed-host-identity";
import { listHostTrustWatch } from "./host-trust-watch-service";

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

const DAY = 24 * 60 * 60 * 1000;

const OPERATOR_ADDRESS = "ops.staf@acme.example";

const tierOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ tier: schema.users.recruiterVerificationTier })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.tier;
};

const confirmedAtOf = async (tx: Database, userId: string): Promise<Date> => {
  const [row] = await tx
    .select({ confirmedAt: schema.hostOrganizationEmails.confirmedAt })
    .from(schema.hostOrganizationEmails)
    .where(eq(schema.hostOrganizationEmails.userId, userId));
  if (!row) throw new Error("No Email organisasi row");
  return row.confirmedAt;
};

type RemovedOnDomain = { userId: string; removedAt: Date };

// The removal goes through the real services, then is moved back as backdateRemoval says, and the
// record is written again so it carries the moved removal time.
const removeOnDomain = async (
  tx: Database,
  operatorId: string,
  address: string,
  phoneNumber: string,
  organizationAddress: string,
  interval: string,
): Promise<RemovedOnDomain> => {
  const userId = await signUpHost(tx, address, phoneNumber);
  await trustByOrganizationEmail(tx, userId, organizationAddress);
  await removeTrust(tx, operatorId, userId);
  await backdateRemoval(tx, userId, interval);
  await recordRemovedHostIdentity(tx, userId);
  const [record] = await tx
    .select({ removedAt: schema.hostTrustRemovals.removedAt })
    .from(schema.hostTrustRemovals)
    .where(eq(schema.hostTrustRemovals.userId, userId));
  if (!record) throw new Error("No record row");
  return { userId, removedAt: record.removedAt };
};

const trustedColleague = async (
  tx: Database,
  address: string,
  phoneNumber: string,
  organizationAddress: string,
): Promise<string> => {
  const userId = await signUpHost(tx, address, phoneNumber);
  await trustByOrganizationEmail(tx, userId, organizationAddress);
  return userId;
};

// Planted directly: inside one test transaction every write shares one clock, so a trust from before
// the removal is moved back.
const backdateTrust = async (tx: Database, userId: string, interval: string): Promise<void> => {
  await tx
    .update(schema.hostOrganizationEmails)
    .set({ confirmedAt: sql`now() - ${interval}::interval` })
    .where(eq(schema.hostOrganizationEmails.userId, userId));
  await tx
    .update(schema.users)
    .set({ recruiterVerifiedAt: sql`now() - ${interval}::interval` })
    .where(eq(schema.users.id, userId));
};

// Planted directly: an account trusted again while its record stands, which no path leaves, because
// the raise and the approval delete the record.
const plantTrusted = async (tx: Database, userId: string): Promise<void> => {
  await tx
    .update(schema.users)
    .set({ recruiterVerificationTier: "elevated" })
    .where(eq(schema.users.id, userId));
};

// Planted directly: a deletion removes the Email organisasi in the same transaction, so no path
// leaves an inactive account holding one.
const plantDeactivated = async (tx: Database, userId: string): Promise<void> => {
  await tx.update(schema.users).set({ status: "deactivated" }).where(eq(schema.users.id, userId));
};

const countRows = async (tx: Database) => {
  const [usersCount] = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.users);
  const [organizationEmailsCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.hostOrganizationEmails);
  const [recordsCount] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.hostTrustRemovals);
  return {
    users: usersCount?.count,
    organizationEmails: organizationEmailsCount?.count,
    records: recordsCount?.count,
  };
};

const watchOf = async (tx: Database, userIds: string[]) => {
  const entries = await listHostTrustWatch(tx);
  return entries.filter((entry) => userIds.includes(entry.userId));
};

const watchEnd = (removal: RemovedOnDomain): Date =>
  new Date(removal.removedAt.getTime() + 90 * DAY);

const entryOf = async (
  tx: Database,
  userId: string,
  signInEmail: string,
  organizationEmail: string,
  watchEndsAt: Date,
) => ({
  userId,
  name: "Rina Pratama",
  signInEmail,
  organizationEmail,
  domain: "acme.example",
  trustedSince: await confirmedAtOf(tx, userId),
  watchEndsAt,
});

describe.skipIf(skipWithoutDatabase)("the domain watch against a real database", () => {
  it("lists the accounts newly trusted on a watched organization domain or under it, newest first, until 90 days after the removal", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await removeOnDomain(
        tx,
        operator,
        "rudi.host@seed.lombakita.local",
        "0812-3456-7890",
        "rudi@acme.example",
        "10 days",
      );
      const sari = await removeOnDomain(
        tx,
        operator,
        "sari.host@seed.lombakita.local",
        "0822-1111-3333",
        "sari@lama.example",
        "91 days",
      );
      const citra = await trustedColleague(
        tx,
        "citra.lokal@seed.lombakita.local",
        "0821-3333-4444",
        "citra@acme.example",
      );
      const andi = await trustedColleague(
        tx,
        "andi.lokal@seed.lombakita.local",
        "0821-4444-5555",
        "andi@lab.acme.example",
      );
      await backdateTrust(tx, andi, "2 days");
      const bayu = await trustedColleague(
        tx,
        "bayu.lokal@seed.lombakita.local",
        "0821-5656-7878",
        "bayu@other.example",
      );
      const tono = await trustedColleague(
        tx,
        "tono.lokal@seed.lombakita.local",
        "0821-1212-3434",
        "tono@acme.example",
      );
      await backdateTrust(tx, tono, "20 days");
      const sinta = await trustedColleague(
        tx,
        "sinta.lokal@seed.lombakita.local",
        "0821-8888-9999",
        "sinta@acme.example",
      );
      await suspendUser(operator, sinta, "Penangguhan sementara.", tx);
      const nina = await signUpHost(tx, "nina.lokal@seed.lombakita.local", "+62 812 3456 7890");
      await trustByOrganizationEmail(tx, nina, "nina@acme.example");
      expect(await tierOf(tx, nina)).toBe("minimal");
      const lia = await trustedColleague(
        tx,
        "lia.lokal@seed.lombakita.local",
        "0821-2323-4545",
        "lia@lama.example",
      );

      const listed = await watchOf(tx, [
        rudi.userId,
        sari.userId,
        citra,
        andi,
        bayu,
        tono,
        sinta,
        nina,
        lia,
      ]);

      expect(listed).toEqual([
        await entryOf(
          tx,
          citra,
          "citra.lokal@seed.lombakita.local",
          "citra@acme.example",
          watchEnd(rudi),
        ),
        await entryOf(
          tx,
          andi,
          "andi.lokal@seed.lombakita.local",
          "andi@lab.acme.example",
          watchEnd(rudi),
        ),
      ]);
    });
  });

  it("lists a colleague trusted before the removal once it confirms another Email organisasi after it, from that confirm", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await removeOnDomain(
        tx,
        operator,
        "rudi.host@seed.lombakita.local",
        "0812-3456-7890",
        "rudi@acme.example",
        "10 days",
      );
      const putri = await trustedColleague(
        tx,
        "putri.lokal@seed.lombakita.local",
        "0821-6767-8989",
        "putri@acme.example",
      );
      await backdateTrust(tx, putri, "20 days");
      await trustByOrganizationEmail(tx, putri, "putri.lab@acme.example");

      const listed = await watchOf(tx, [putri]);

      expect(listed).toEqual([
        await entryOf(
          tx,
          putri,
          "putri.lokal@seed.lombakita.local",
          "putri.lab@acme.example",
          watchEnd(rudi),
        ),
      ]);
    });
  });

  it("lists an account that two watches on its domain cover once, until the later watch ends", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      await removeOnDomain(
        tx,
        operator,
        "rudi.host@seed.lombakita.local",
        "0812-3456-7890",
        "rudi@acme.example",
        "10 days",
      );
      const sari = await removeOnDomain(
        tx,
        operator,
        "sari.host@seed.lombakita.local",
        "0822-1111-3333",
        "sari@acme.example",
        "5 days",
      );
      const citra = await trustedColleague(
        tx,
        "citra.lokal@seed.lombakita.local",
        "0821-3333-4444",
        "citra@acme.example",
      );

      const listed = await watchOf(tx, [citra]);

      expect(listed).toEqual([
        await entryOf(
          tx,
          citra,
          "citra.lokal@seed.lombakita.local",
          "citra@acme.example",
          watchEnd(sari),
        ),
      ]);
    });
  });

  it("never lists the removed account, even while it holds trust and its record", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      const rudi = await removeOnDomain(
        tx,
        operator,
        "rudi.host@seed.lombakita.local",
        "0812-3456-7890",
        "rudi@acme.example",
        "10 days",
      );
      await plantTrusted(tx, rudi.userId);
      expect(await tierOf(tx, rudi.userId)).toBe("elevated");

      const listed = await watchOf(tx, [rudi.userId]);

      expect(listed).toEqual([]);
    });
  });

  it("never lists an account that is not active", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      await removeOnDomain(
        tx,
        operator,
        "rudi.host@seed.lombakita.local",
        "0812-3456-7890",
        "rudi@acme.example",
        "10 days",
      );
      const citra = await trustedColleague(
        tx,
        "citra.lokal@seed.lombakita.local",
        "0821-3333-4444",
        "citra@acme.example",
      );
      await plantDeactivated(tx, citra);

      const listed = await watchOf(tx, [citra]);

      expect(listed).toEqual([]);
    });
  });

  it("writes no row when staff read the watch", async () => {
    await inRollback(async (tx) => {
      await clearRecordsInsideRollback(tx);
      const operator = await plantOperator(tx, OPERATOR_ADDRESS);
      await removeOnDomain(
        tx,
        operator,
        "rudi.host@seed.lombakita.local",
        "0812-3456-7890",
        "rudi@acme.example",
        "10 days",
      );
      const citra = await trustedColleague(
        tx,
        "citra.lokal@seed.lombakita.local",
        "0821-3333-4444",
        "citra@acme.example",
      );
      const before = await countRows(tx);

      const listed = await watchOf(tx, [citra]);

      expect(listed).toHaveLength(1);
      expect(await countRows(tx)).toEqual(before);
    });
  });
});
