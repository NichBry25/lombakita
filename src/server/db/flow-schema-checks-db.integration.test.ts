// @vitest-environment node
//
// The CHECK constraints of the flow simplification tables, against a real Postgres. Each case runs
// inside a transaction that is always rolled back, and a refusal runs in a nested transaction so
// the outer one stays usable for the next statement.

import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { TransactionRollbackError, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  competitionReports,
  competitions,
  hostOrganizationEmails,
  institutions,
  organizationEmailChallenges,
  users,
} from "@/server/db/schema";
import { NEW_INSTITUTION_DEFAULT_STATUS } from "@/server/institution-workspace/institution-service";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<NonNullable<typeof db>["transaction"]>[0]>[0];

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

/** The name of the constraint the database refused with, or a throw when it accepted the write. */
const refusedConstraint = async (tx: Tx, body: (tx: Tx) => Promise<unknown>): Promise<string> => {
  try {
    await tx.transaction(async (nested) => {
      await body(nested);
    });
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; current && depth < 5; depth += 1) {
      const e = current as { code?: string; constraint_name?: string; cause?: unknown };
      if (e.code === "23514") return e.constraint_name ?? "";
      current = e.cause;
    }
    throw error;
  }
  throw new Error("expected the database to refuse this write, but it was accepted");
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

const seedUser = async (tx: Tx): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `flow_checks_${id}@example.test`,
      username: `flow_checks_${id}`,
      role: "candidate",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
};

const seedCompetition = async (tx: Tx): Promise<string> => {
  const id = uniqueSuffix();
  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `flow-checks-inst-${id}`,
      institutionType: "company",
      displayName: `Flow Checks ${id}`,
      status: NEW_INSTITUTION_DEFAULT_STATUS,
    })
    .returning({ id: institutions.id });
  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `flow-checks-comp-${id}`,
      title: `Flow checks ${id}`,
      status: "draft",
    })
    .returning({ id: competitions.id });
  return competition!.id;
};

const challengeFor = (userId: string, email: string) => ({
  userId,
  email,
  codeHash: "hash",
  expiresAt: new Date(Date.now() + 600_000),
});

describe.skipIf(skipWithoutDatabase)("organization_email_challenges_email_normalized_chk", () => {
  it("refuses an email with an upper-case letter", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);

      const constraint = await refusedConstraint(tx, (nested) =>
        nested.insert(organizationEmailChallenges).values(challengeFor(userId, "Ceo@acme.example")),
      );

      expect(constraint).toBe("organization_email_challenges_email_normalized_chk");
    });
  });

  it("accepts the same email in lower case", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);

      await tx.insert(organizationEmailChallenges).values(challengeFor(userId, "ceo@acme.example"));
    });
  });
});

describe.skipIf(skipWithoutDatabase)("host_organization_emails_email_domain_chk", () => {
  const emailRow = (userId: string, email: string, domain: string) => ({
    userId,
    email,
    domain,
    confirmedAt: new Date(),
  });

  it("refuses a domain that matches only as a LIKE wildcard", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);

      const constraint = await refusedConstraint(tx, (nested) =>
        nested
          .insert(hostOrganizationEmails)
          .values(emailRow(userId, "a@bxample.com", "_xample.com")),
      );

      expect(constraint).toBe("host_organization_emails_email_domain_chk");
    });
  });

  it("refuses a domain that differs from the email's domain", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);

      const constraint = await refusedConstraint(tx, (nested) =>
        nested
          .insert(hostOrganizationEmails)
          .values(emailRow(userId, "a@acme.example", "other.example")),
      );

      expect(constraint).toBe("host_organization_emails_email_domain_chk");
    });
  });

  it("accepts the exact domain after the @", async () => {
    await inRollback(async (tx) => {
      const userId = await seedUser(tx);

      await tx
        .insert(hostOrganizationEmails)
        .values(emailRow(userId, "a@acme.example", "acme.example"));
    });
  });
});

describe.skipIf(skipWithoutDatabase)("competition_reports_note_required_chk", () => {
  it("refuses a lainnya report whose note is only spaces", async () => {
    await inRollback(async (tx) => {
      const reporterUserId = await seedUser(tx);
      const competitionId = await seedCompetition(tx);

      const constraint = await refusedConstraint(tx, (nested) =>
        nested
          .insert(competitionReports)
          .values({ competitionId, reporterUserId, reason: "lainnya", note: "   " }),
      );

      expect(constraint).toBe("competition_reports_note_required_chk");
    });
  });

  it("accepts a lainnya report with a real note", async () => {
    await inRollback(async (tx) => {
      const reporterUserId = await seedUser(tx);
      const competitionId = await seedCompetition(tx);

      await tx
        .insert(competitionReports)
        .values({ competitionId, reporterUserId, reason: "lainnya", note: "Hadiah tidak jelas" });
    });
  });
});

describe.skipIf(skipWithoutDatabase)(
  "the competition checks the freeze and the fraud cancel use",
  () => {
    it("accepts a competition cancelled for fraud", async () => {
      await inRollback(async (tx) => {
        const competitionId = await seedCompetition(tx);

        await tx.execute(
          sql`update "competitions" set "cancelled_at" = now(), "cancellation_reason" = 'fraud' where "id" = ${competitionId}`,
        );
      });
    });

    it("refuses frozen_at without a frozen_reason", async () => {
      await inRollback(async (tx) => {
        const competitionId = await seedCompetition(tx);

        const constraint = await refusedConstraint(tx, (nested) =>
          nested.execute(
            sql`update "competitions" set "frozen_at" = now() where "id" = ${competitionId}`,
          ),
        );

        expect(constraint).toBe("competitions_frozen_pair_chk");
      });
    });
  },
);
