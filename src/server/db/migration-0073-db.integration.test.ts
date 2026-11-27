// @vitest-environment node

// Migrations 0073 and 0074 against the database: the name backfill run on temporary tables that
// shadow the real ones, and the required name on the real institutions table. Every test runs in a
// transaction that is always rolled back.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TransactionRollbackError, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";

const BACKFILL_SQL = readFileSync(
  resolve(process.cwd(), "drizzle/0073_flow_one_workspace_names.sql"),
  "utf8",
);

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

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
): Promise<{ code: string; constraint: string; column: string }> => {
  try {
    await tx.transaction(async (nested) => {
      await body(nested);
    });
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; current && depth < 5; depth += 1) {
      const e = current as {
        code?: string;
        constraint_name?: string;
        constraint?: string;
        column_name?: string;
        column?: string;
        cause?: unknown;
      };
      if (typeof e.code === "string") {
        return {
          code: e.code,
          constraint: e.constraint_name ?? e.constraint ?? "",
          column: e.column_name ?? e.column ?? "",
        };
      }
      current = e.cause;
    }
    throw error;
  }
  throw new Error("expected the database to refuse this row, but it was accepted");
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

describe.skipIf(skipWithoutDatabase)("migrations 0073 and 0074 against the database", () => {
  it("writes Ruang kerja pribadi into every personal row that stores no name and changes no other row or updated_at", async () => {
    await inRollback(async (tx) => {
      // A temporary table is found before the real one of the same name, so the file's text runs
      // unchanged against the planted rows and no real row is written or locked.
      await tx.execute(
        sql`create temp table institutions (id text, display_name text, institution_type text, updated_at timestamptz)`,
      );
      const plantedRows = [
        sql`('p-null-1', null, 'personal', '2026-01-02T03:04:05.000Z')`,
        sql`('p-null-2', null, 'personal', '2026-01-02T03:04:05.000Z')`,
        sql`('p-deleted', 'Institusi dihapus', 'personal', '2026-01-02T03:04:05.000Z')`,
        sql`('c-acme', 'Acme', 'company', '2026-01-02T03:04:05.000Z')`,
        // Only a shadow row can hold this: the real table refuses a row with no name.
        sql`('c-null', null, 'company', '2026-01-02T03:04:05.000Z')`,
      ];
      await tx.execute(
        sql`insert into institutions (id, display_name, institution_type, updated_at) values ${sql.join(plantedRows, sql`, `)}`,
      );

      const shadowCheck = await tx.execute(
        sql`select (select relnamespace from pg_class where oid = 'institutions'::regclass) = pg_my_temp_schema() as shadowed`,
      );
      expect([...shadowCheck]).toEqual([{ shadowed: true }]);

      await tx.execute(sql.raw(BACKFILL_SQL));

      const rows = await tx.execute(
        sql`select id, display_name, institution_type, updated_at = timestamptz '2026-01-02T03:04:05.000Z' as updated_at_kept from institutions order by id`,
      );
      expect([...rows]).toEqual([
        {
          id: "c-acme",
          display_name: "Acme",
          institution_type: "company",
          updated_at_kept: true,
        },
        { id: "c-null", display_name: null, institution_type: "company", updated_at_kept: true },
        {
          id: "p-deleted",
          display_name: "Institusi dihapus",
          institution_type: "personal",
          updated_at_kept: true,
        },
        {
          id: "p-null-1",
          display_name: "Ruang kerja pribadi",
          institution_type: "personal",
          updated_at_kept: true,
        },
        {
          id: "p-null-2",
          display_name: "Ruang kerja pribadi",
          institution_type: "personal",
          updated_at_kept: true,
        },
      ]);
    });
  });

  it("refuses an institution with no name, and the old name CHECK is gone", async () => {
    await inRollback(async (tx) => {
      const slug = `mig73-${uniqueSuffix()}`;
      const refusal = await expectRejection(tx, (nested) =>
        nested.execute(
          sql`insert into institutions (slug, institution_type) values (${slug}, 'personal')`,
        ),
      );
      expect(refusal.code).toBe("23502");
      expect(refusal.column).toBe("display_name");

      const remaining = await tx.execute(
        sql`select count(*)::int as n from pg_constraint where conname = 'institutions_display_name_type_chk'`,
      );
      expect([...remaining]).toEqual([{ n: 0 }]);
    });
  });
});
