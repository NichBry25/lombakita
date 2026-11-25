// @vitest-environment node
//
// Which host sign-up numbers a deletion clears, against a real Postgres: every sign-up of an
// elevated account, the approved ones of any other (DEC-0274).
//
// Every row that a writer still exists for is built through it: the raise through
// `elevateRecruiterTier` and each contact through `setCompetitionOrganizerContactForEditor`. The
// sign-up rows are planted. The rejected and draft rows stand for older host requests, which no path
// writes any more, and the pending row is a host check on the host's own draft, planted because the
// press that opens one needs a publishable draft this file does not build. The raise closes that
// check as approved. Users, institutions, memberships and competitions are inserted, because no
// writer creates them in a shape these tests need.
//
// Nothing commits. Each test runs in a transaction that is always rolled back, and the action is
// handed a shim whose `transaction` opens a savepoint on that connection, as in
// `account-deidentification-db.integration.test.ts`. The clear reaches every competition in the
// database, so every test uses a number that no other row holds.

import { afterAll, describe, expect, it, vi } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { TransactionRollbackError, and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import {
  competitions,
  institutionMemberships,
  institutions,
  platformOpsAuditLogs,
  recruiterVerificationSubmissions,
  users,
} from "@/server/db/schema";

vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: () => true,
  generatePresignedPutUrl: vi.fn(),
  generatePresignedGetUrl: vi.fn(),
  headObject: vi.fn(),
  readObjectHead: vi.fn(),
  deleteObject: vi.fn(),
  listObjects: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/server/async/enqueue", () => ({
  enqueueRecruiterVerificationRejected: vi.fn().mockResolvedValue(undefined),
  enqueueRecruiterVerificationApproved: vi.fn().mockResolvedValue(undefined),
}));

import {
  ACCOUNT_DEIDENTIFIED_EVENT,
  deidentifyAccount,
} from "@/server/accounts/account-deidentification-service";
import type { Database } from "@/server/db/client";
import { setCompetitionOrganizerContactForEditor } from "@/server/competitions/competition-organizer-contact-service";
import { elevateRecruiterTier } from "@/server/recruiter-tier/recruiter-tier-service";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<NonNullable<typeof db>["transaction"]>[0]>[0];
type AccountDb = Parameters<typeof deidentifyAccount>[3];

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

const asDatabase = (tx: Tx): Database => tx as unknown as Database;

const savepointShimFor = (tx: Tx): AccountDb =>
  ({
    transaction: async (fn: (nested: Tx) => Promise<unknown>) => tx.transaction(fn),
  }) as unknown as AccountDb;

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

type SignupStatus = "pending_review" | "rejected" | "draft";
const UNAPPROVED_SIGNUP_STATUSES: SignupStatus[] = ["pending_review", "rejected", "draft"];

type Account = { id: string; email: string; username: string };

const seedOperator = async (tx: Tx): Promise<string> => {
  const suffix = uniqueSuffix();
  const id = randomUUID();
  await tx.insert(users).values({
    id,
    email: `elevnum_ops_${suffix}@example.test`,
    username: `elevnum_ops_${suffix}`,
    role: "platform_ops",
    candidateVerifiedAt: new Date(),
  });
  return id;
};

const seedHost = async (tx: Tx, label: string): Promise<Account> => {
  const suffix = uniqueSuffix();
  const account = {
    id: randomUUID(),
    email: `elevnum_${label}_${suffix}@example.test`,
    username: `elevnum_${label}_${suffix}`,
  };
  await tx.insert(users).values({
    ...account,
    role: "recruiter",
    emailVerified: new Date(),
    recruiterVerifiedAt: new Date(),
    recruiterVerificationTier: "minimal",
  });
  return account;
};

const seedInstitutionOwnedBy = async (
  tx: Tx,
  owner: Account,
  institutionType: "personal" | "company",
): Promise<string> => {
  const institutionId = randomUUID();
  await tx.insert(institutions).values({
    id: institutionId,
    slug: `elevnum-${institutionType}-${uniqueSuffix()}`,
    institutionType,
    displayName: `Penyelenggara ${institutionType}`,
    status: "active",
    verificationStatus: "verified",
  });
  await tx.insert(institutionMemberships).values({
    id: randomUUID(),
    institutionId,
    userId: owner.id,
    membershipRole: "institution_owner",
    status: "active",
  });
  return institutionId;
};

const seedCompetition = async (
  tx: Tx,
  institutionId: string,
  status: "draft" | "published",
): Promise<string> => {
  const competitionId = randomUUID();
  const suffix = uniqueSuffix();
  await tx.insert(competitions).values({
    id: competitionId,
    institutionId,
    slug: `elevnum-comp-${suffix}`,
    title: `Kompetisi ${suffix}`,
    status,
    publishedAt: status === "published" ? new Date() : null,
  });
  return competitionId;
};

const newNationalNumber = (): string => `812${randomInt(10_000_000, 100_000_000)}`;
const typedAsSignup = (national: string): string =>
  `+62 ${national.slice(0, 3)}-${national.slice(3, 7)}-${national.slice(7)}`;
const typedAsContact = (national: string): string => `0${national}`;
const storedAsDial = (national: string): string => `62${national}`;

const fileSignup = async (
  tx: Tx,
  host: Account,
  operatorId: string,
  status: SignupStatus,
  mobileNumber: string,
  competitionId: string,
): Promise<void> => {
  await tx.insert(recruiterVerificationSubmissions).values({
    userId: host.id,
    fullName: "Penyelenggara Uji",
    mobileNumber,
    status,
    competitionId: status === "pending_review" ? competitionId : null,
    ...(status === "rejected"
      ? { reviewerUserId: operatorId, reviewedAt: new Date(), rejectionReason: "nomor tidak cocok" }
      : {}),
  });
};

const setContactThroughEditor = async (
  tx: Tx,
  editor: Account,
  competitionId: string,
  kind: "whatsapp" | "phone",
  national: string,
): Promise<void> => {
  await setCompetitionOrganizerContactForEditor(
    editor.id,
    competitionId,
    { kind, value: typedAsContact(national) },
    asDatabase(tx),
  );
};

type Scenario = {
  operatorId: string;
  host: Account;
  hostNumber: string;
  ownCompetition: string;
  otherCompetition: string;
  unrelatedCompetition: string;
  unrelatedNumber: string;
};

// A host with its own competition, and a second host in another institution whose competitions
// carry the same number and a different one. The raise, when asked for, follows the sign-up.
const buildScenario = async (
  tx: Tx,
  status: SignupStatus,
  raiseToElevated: boolean,
): Promise<Scenario> => {
  const operatorId = await seedOperator(tx);
  const host = await seedHost(tx, "host");
  const otherHost = await seedHost(tx, "other");

  const personalInstitutionId = await seedInstitutionOwnedBy(tx, host, "personal");
  const ownCompetition = await seedCompetition(tx, personalInstitutionId, "draft");
  const otherInstitutionId = await seedInstitutionOwnedBy(tx, otherHost, "company");
  const otherCompetition = await seedCompetition(tx, otherInstitutionId, "published");
  const unrelatedCompetition = await seedCompetition(tx, otherInstitutionId, "published");

  const hostNumber = newNationalNumber();
  const unrelatedNumber = newNationalNumber();
  await fileSignup(tx, host, operatorId, status, typedAsSignup(hostNumber), ownCompetition);

  if (raiseToElevated) {
    await elevateRecruiterTier(operatorId, host.id, asDatabase(tx));
  }

  await setContactThroughEditor(tx, host, ownCompetition, "whatsapp", hostNumber);
  await setContactThroughEditor(tx, otherHost, otherCompetition, "phone", hostNumber);
  await setContactThroughEditor(tx, otherHost, unrelatedCompetition, "phone", unrelatedNumber);

  return {
    operatorId,
    host,
    hostNumber,
    ownCompetition,
    otherCompetition,
    unrelatedCompetition,
    unrelatedNumber,
  };
};

const deleteHost = async (tx: Tx, scenario: Scenario): Promise<void> => {
  await deidentifyAccount(
    scenario.operatorId,
    scenario.host.id,
    { confirmUsername: scenario.host.username, reason: "permintaan pemilik" },
    savepointShimFor(tx),
  );
};

const readContact = async (tx: Tx, competitionId: string) => {
  const [row] = await tx
    .select({
      kind: competitions.organizerContactKind,
      value: competitions.organizerContactValue,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);
  return row;
};

const readTier = async (tx: Tx, accountId: string): Promise<string> => {
  const [row] = await tx
    .select({ tier: users.recruiterVerificationTier })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  return row!.tier;
};

const readSignupStatuses = async (tx: Tx, accountId: string): Promise<string[]> => {
  const rows = await tx
    .select({ status: recruiterVerificationSubmissions.status })
    .from(recruiterVerificationSubmissions)
    .where(eq(recruiterVerificationSubmissions.userId, accountId));
  return rows.map((row) => row.status);
};

const readClearedCompetitionIds = async (tx: Tx, accountId: string): Promise<string[]> => {
  const [audit] = await tx
    .select({ metadata: platformOpsAuditLogs.metadata })
    .from(platformOpsAuditLogs)
    .where(
      and(
        eq(platformOpsAuditLogs.targetUserId, accountId),
        eq(platformOpsAuditLogs.eventType, ACCOUNT_DEIDENTIFIED_EVENT),
      ),
    );
  const metadata = audit!.metadata as {
    clearedOrganizerContacts: { competitionId: string; institutionId: string }[];
  };
  return metadata.clearedOrganizerContacts.map((cleared) => cleared.competitionId);
};

describe.skipIf(skipWithoutDatabase)("the sign-up numbers a deletion clears, real database", () => {
  describe("an elevated account", () => {
    it.each(UNAPPROVED_SIGNUP_STATUSES)(
      "clears the number of its %s sign-up from its own competition and from another institution's",
      async (status) => {
        await inRollback(async (tx) => {
          const scenario = await buildScenario(tx, status, true);
          const before = {
            tier: await readTier(tx, scenario.host.id),
            signups: await readSignupStatuses(tx, scenario.host.id),
            own: await readContact(tx, scenario.ownCompetition),
            other: await readContact(tx, scenario.otherCompetition),
          };

          await deleteHost(tx, scenario);

          expect(before).toEqual({
            tier: "elevated",
            signups: [status === "pending_review" ? "approved" : status],
            own: { kind: "whatsapp", value: storedAsDial(scenario.hostNumber) },
            other: { kind: "phone", value: storedAsDial(scenario.hostNumber) },
          });
          expect({
            own: await readContact(tx, scenario.ownCompetition),
            other: await readContact(tx, scenario.otherCompetition),
          }).toEqual({
            own: { kind: null, value: null },
            other: { kind: null, value: null },
          });
          expect(await readClearedCompetitionIds(tx, scenario.host.id)).toEqual(
            expect.arrayContaining([scenario.ownCompetition, scenario.otherCompetition]),
          );
        });
      },
    );

    it("keeps a contact that matches none of its sign-up numbers", async () => {
      await inRollback(async (tx) => {
        const scenario = await buildScenario(tx, "pending_review", true);

        await deleteHost(tx, scenario);

        expect(await readContact(tx, scenario.unrelatedCompetition)).toEqual({
          kind: "phone",
          value: storedAsDial(scenario.unrelatedNumber),
        });
      });
    });
  });

  describe("an account that is not elevated", () => {
    it.each(UNAPPROVED_SIGNUP_STATUSES)(
      "keeps every contact carrying the number of its %s sign-up",
      async (status) => {
        await inRollback(async (tx) => {
          const scenario = await buildScenario(tx, status, false);
          const tierBefore = await readTier(tx, scenario.host.id);

          await deleteHost(tx, scenario);

          expect(tierBefore).toBe("minimal");
          expect({
            own: await readContact(tx, scenario.ownCompetition),
            other: await readContact(tx, scenario.otherCompetition),
          }).toEqual({
            own: { kind: "whatsapp", value: storedAsDial(scenario.hostNumber) },
            other: { kind: "phone", value: storedAsDial(scenario.hostNumber) },
          });
        });
      },
    );
  });
});
