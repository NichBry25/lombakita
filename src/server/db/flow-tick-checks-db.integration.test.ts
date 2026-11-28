// @vitest-environment node
//
// The tick backfill and the CHECK constraints of the tick columns, against a real Postgres. Each
// case runs inside a transaction that is always rolled back, and a refusal runs in a nested
// transaction so the outer one stays usable for the next statement. The database is the guard
// here, so the writes are direct and no service builds them.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { TransactionRollbackError, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { institutionVerificationSubmissions, institutions } from "@/server/db/schema";
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

type PlantedInstitution = {
  verificationStatus?: "pending_verification" | "verified";
  verifiedAt?: Date;
  updatedAt?: Date;
  tickPath?: "domain" | "instagram" | "documents" | "staff";
};

const plantInstitution = async (tx: Tx, planted: PlantedInstitution = {}): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(institutions)
    .values({
      slug: `flow-tick-checks-${id}`,
      institutionType: "company",
      displayName: `Flow Tick Checks ${id}`,
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      ...planted,
    })
    .returning({ id: institutions.id });
  return row!.id;
};

const plantApprovedSubmission = async (tx: Tx, institutionId: string): Promise<void> => {
  await tx.insert(institutionVerificationSubmissions).values({
    institutionId,
    targetInstitutionType: "company",
    status: "approved",
  });
};

const readInstitution = async (tx: Tx, institutionId: string) => {
  const [row] = await tx
    .select({
      tickPath: institutions.tickPath,
      tickDomain: institutions.tickDomain,
      verifiedAt: institutions.verifiedAt,
      updatedAt: institutions.updatedAt,
    })
    .from(institutions)
    .where(eq(institutions.id, institutionId));
  return row!;
};

const readBackfillStatements = (): string[] => {
  const file = resolve(process.cwd(), "drizzle/0075_flow_tick_paths.sql");
  return readFileSync(file, "utf8").split("--> statement-breakpoint");
};

const VERIFIED = { verificationStatus: "verified" } as const;

describe.skipIf(skipWithoutDatabase)("flow-tick checks", () => {
  it("the backfill gives documents to a verified institution with an approved request and staff to one without", async () => {
    await inRollback(async (tx) => {
      const verifiedAt = new Date("2026-03-01T00:00:00.000Z");
      const updatedAt = new Date("2026-03-02T00:00:00.000Z");
      const planted = { verifiedAt, updatedAt };
      const withRequest = await plantInstitution(tx, { ...VERIFIED, ...planted });
      const withoutRequest = await plantInstitution(tx, { ...VERIFIED, ...planted });
      const notVerified = await plantInstitution(tx, {
        verificationStatus: "pending_verification",
        ...planted,
      });
      await plantApprovedSubmission(tx, withRequest);
      await plantApprovedSubmission(tx, notVerified);

      for (const statement of readBackfillStatements()) {
        await tx.execute(sql.raw(statement));
      }

      const rows = [
        await readInstitution(tx, withRequest),
        await readInstitution(tx, withoutRequest),
        await readInstitution(tx, notVerified),
      ];
      expect(rows.map((row) => row.tickPath)).toEqual(["documents", "staff", null]);
      expect(rows.map((row) => row.verifiedAt)).toEqual([verifiedAt, verifiedAt, verifiedAt]);
      expect(rows.map((row) => row.updatedAt)).toEqual([updatedAt, updatedAt, updatedAt]);
    });
  });

  it("the tick path check refuses a path on an institution that is not verified", async () => {
    await inRollback(async (tx) => {
      const institutionId = await plantInstitution(tx, {
        verificationStatus: "pending_verification",
      });

      const constraint = await refusedConstraint(tx, (nested) =>
        nested
          .update(institutions)
          .set({ tickPath: "staff" })
          .where(eq(institutions.id, institutionId)),
      );

      expect(constraint).toBe("institutions_tick_path_verified_chk");
    });
  });

  it("a domain is recorded only for a domain tick", async () => {
    await inRollback(async (tx) => {
      const onStaffTick = await plantInstitution(tx, { ...VERIFIED, tickPath: "staff" });
      const withNoPath = await plantInstitution(tx);
      const verified = await plantInstitution(tx, VERIFIED);

      const staffTickRefusal = await refusedConstraint(tx, (nested) =>
        nested
          .update(institutions)
          .set({ tickDomain: "acme.example" })
          .where(eq(institutions.id, onStaffTick)),
      );
      const noPathRefusal = await refusedConstraint(tx, (nested) =>
        nested
          .update(institutions)
          .set({ tickDomain: "acme.example" })
          .where(eq(institutions.id, withNoPath)),
      );
      await tx
        .update(institutions)
        .set({ tickPath: "domain" })
        .where(eq(institutions.id, verified));
      const accepted = await readInstitution(tx, verified);

      expect(staffTickRefusal).toBe("institutions_tick_domain_path_chk");
      expect(noPathRefusal).toBe("institutions_tick_domain_path_chk");
      expect(accepted.tickPath).toBe("domain");
      expect(accepted.tickDomain).toBeNull();
    });
  });

  it("a name proof needs a domain tick and excludes a name check", async () => {
    await inRollback(async (tx) => {
      const dueAt = new Date("2026-04-01T00:00:00.000Z");
      const onDocumentsTick = await plantInstitution(tx, { ...VERIFIED, tickPath: "documents" });
      const proofOnNoPath = await plantInstitution(tx);
      const checkOnNoPath = await plantInstitution(tx);
      const checkAndProof = await plantInstitution(tx, { ...VERIFIED, tickPath: "domain" });
      const reminderWithoutDue = await plantInstitution(tx, { ...VERIFIED, tickPath: "domain" });

      const proofOnDocumentsTick = await refusedConstraint(tx, (nested) =>
        nested
          .update(institutions)
          .set({ nameProofDueAt: dueAt })
          .where(eq(institutions.id, onDocumentsTick)),
      );
      const proofWithNoPath = await refusedConstraint(tx, (nested) =>
        nested
          .update(institutions)
          .set({ nameProofDueAt: dueAt })
          .where(eq(institutions.id, proofOnNoPath)),
      );
      const checkWithNoPath = await refusedConstraint(tx, (nested) =>
        nested
          .update(institutions)
          .set({ nameCheckedAt: dueAt })
          .where(eq(institutions.id, checkOnNoPath)),
      );
      const checkTogetherWithProof = await refusedConstraint(tx, (nested) =>
        nested
          .update(institutions)
          .set({ nameCheckedAt: dueAt, nameProofDueAt: dueAt })
          .where(eq(institutions.id, checkAndProof)),
      );
      const reminderOnly = await refusedConstraint(tx, (nested) =>
        nested
          .update(institutions)
          .set({ nameProofRemindedAt: dueAt })
          .where(eq(institutions.id, reminderWithoutDue)),
      );

      expect(proofOnDocumentsTick).toBe("institutions_name_proof_path_chk");
      expect(proofWithNoPath).toBe("institutions_name_proof_path_chk");
      expect(checkWithNoPath).toBe("institutions_name_proof_path_chk");
      expect(checkTogetherWithProof).toBe("institutions_name_check_or_proof_chk");
      expect(reminderOnly).toBe("institutions_name_proof_reminder_chk");
    });
  });

  it("an Instagram request needs its link and a documents request has none", async () => {
    await inRollback(async (tx) => {
      const institutionId = await plantInstitution(tx);
      const request = {
        institutionId,
        targetInstitutionType: "company",
      } as const;
      const link = "https://instagram.example/flow-tick-checks";

      const instagramWithoutLink = await refusedConstraint(tx, (nested) =>
        nested
          .insert(institutionVerificationSubmissions)
          .values({ ...request, requestedPath: "instagram", instagramUrl: null }),
      );
      const documentsWithLink = await refusedConstraint(tx, (nested) =>
        nested
          .insert(institutionVerificationSubmissions)
          .values({ ...request, requestedPath: "documents", instagramUrl: link }),
      );
      const domainRequest = await refusedConstraint(tx, (nested) =>
        nested
          .insert(institutionVerificationSubmissions)
          .values({ ...request, requestedPath: "domain", instagramUrl: null }),
      );

      expect(instagramWithoutLink).toBe("institution_verification_submissions_instagram_chk");
      expect(documentsWithLink).toBe("institution_verification_submissions_instagram_chk");
      expect(domainRequest).toBe("institution_verification_submissions_requested_path_chk");
    });
  });
});
