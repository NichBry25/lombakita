// @vitest-environment node
//
// What the sitemap is allowed to advertise, run against a real Postgres.
//
// The sitemap tells a crawler which pages exist and invites it to fetch them. An entry for a draft
// competition is a disclosure — it names an unpublished title and an organizer who has not
// announced anything — and it is a disclosure nobody would notice, because the file is read by
// machines and no person opens it. Publication state is therefore decided in the WHERE clause, and
// only Postgres can settle whether that clause actually excludes what it claims to.
//
// Every exclusion below is asserted in both directions: the withheld row is absent AND a published
// row seeded in the same transaction is present. A query returning nothing at all would otherwise
// satisfy every "is not in the sitemap" assertion here.
//
// Every test runs inside a transaction that is ALWAYS rolled back, so the dev database is left
// byte-identical. Nothing here is committed.
//
// Skipped when no DATABASE_URL is reachable, so a developer without a local database can still
// run `npm test`. NOT skippable in CI: `REQUIRE_DB_TESTS=1` makes a missing database a hard
// failure instead (see server/testing/database-url.ts).

import { afterAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TransactionRollbackError } from "drizzle-orm";
import postgres from "postgres";
import { competitions, institutions } from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { listSitemapCompetitions } from "@/server/competitions/competition-public-service";
import { listSitemapInstitutions } from "@/server/institution-workspace/institution-public-service";

const DATABASE_URL = TEST_DATABASE_URL;

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

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

type InstitutionOptions = {
  suspended?: boolean;
  personal?: boolean;
};

const seedInstitution = async (
  tx: Tx,
  options: InstitutionOptions = {},
): Promise<{ id: string; slug: string }> => {
  const id = uniqueSuffix();
  const personal = options.personal ?? false;

  const [row] = await tx
    .insert(institutions)
    .values({
      slug: `sitemap-inst-${id}`,
      institutionType: personal ? "personal" : "company",
      // institutions_display_name_type_chk allows a null display name only for `personal`.
      displayName: personal ? null : `Sitemap Fixture ${id}`,
      suspendedAt: options.suspended ? new Date() : null,
    })
    .returning({ id: institutions.id, slug: institutions.slug });

  return row!;
};

type CompetitionOptions = {
  status?: "draft" | "published" | "archived";
  deleted?: boolean;
};

const seedCompetition = async (
  tx: Tx,
  institutionId: string,
  options: CompetitionOptions = {},
): Promise<string> => {
  const id = uniqueSuffix();

  const [row] = await tx
    .insert(competitions)
    .values({
      institutionId,
      slug: `sitemap-comp-${id}`,
      title: `Sitemap fixture ${id}`,
      status: options.status ?? "published",
      publishedAt: (options.status ?? "published") === "published" ? new Date() : null,
      deletedAt: options.deleted ? new Date() : null,
    })
    .returning({ slug: competitions.slug });

  return row!.slug;
};

// `tx as unknown as Database` is the house bridge for calling a service inside a rolled-back
// transaction: a Drizzle transaction handle carries the same query surface but not the schema
// generic, and this keeps the call on the real production function rather than a re-implementation.
const competitionSlugsIn = async (tx: Tx): Promise<string[]> =>
  (await listSitemapCompetitions(tx as unknown as Database)).map((entry) => entry.slug);

const institutionSlugsIn = async (tx: Tx): Promise<string[]> =>
  (await listSitemapInstitutions(tx as unknown as Database)).map((entry) => entry.slug);

describe.skipIf(skipWithoutDatabase)("sitemap competition entries", () => {
  it("advertises a published competition", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const published = await seedCompetition(tx, institution.id, { status: "published" });

      expect(await competitionSlugsIn(tx)).toContain(published);
    });
  });

  it("never advertises a draft competition", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const draft = await seedCompetition(tx, institution.id, { status: "draft" });
      const published = await seedCompetition(tx, institution.id, { status: "published" });

      const slugs = await competitionSlugsIn(tx);
      expect(slugs).not.toContain(draft);
      // The published sibling proves the absence above is an exclusion, not an empty result.
      expect(slugs).toContain(published);
    });
  });

  it("never advertises an archived competition", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const archived = await seedCompetition(tx, institution.id, { status: "archived" });
      const published = await seedCompetition(tx, institution.id, { status: "published" });

      const slugs = await competitionSlugsIn(tx);
      expect(slugs).not.toContain(archived);
      expect(slugs).toContain(published);
    });
  });

  it("never advertises a soft-deleted competition", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);
      const deleted = await seedCompetition(tx, institution.id, {
        status: "published",
        deleted: true,
      });
      const published = await seedCompetition(tx, institution.id, { status: "published" });

      const slugs = await competitionSlugsIn(tx);
      expect(slugs).not.toContain(deleted);
      expect(slugs).toContain(published);
    });
  });

  it("never advertises a published competition belonging to a suspended organizer", async () => {
    await inRollback(async (tx) => {
      const suspended = await seedInstitution(tx, { suspended: true });
      const active = await seedInstitution(tx);

      const withheld = await seedCompetition(tx, suspended.id, { status: "published" });
      const visible = await seedCompetition(tx, active.id, { status: "published" });

      const slugs = await competitionSlugsIn(tx);
      expect(slugs).not.toContain(withheld);
      expect(slugs).toContain(visible);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("sitemap institution entries", () => {
  it("advertises an active organizer", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx);

      expect(await institutionSlugsIn(tx)).toContain(institution.slug);
    });
  });

  it("never advertises a suspended organizer", async () => {
    await inRollback(async (tx) => {
      const suspended = await seedInstitution(tx, { suspended: true });
      const active = await seedInstitution(tx);

      const slugs = await institutionSlugsIn(tx);
      expect(slugs).not.toContain(suspended.slug);
      expect(slugs).toContain(active.slug);
    });
  });

  it("never advertises a personal institution, whose page only redirects to a withheld profile", async () => {
    await inRollback(async (tx) => {
      const personal = await seedInstitution(tx, { personal: true });
      const organizer = await seedInstitution(tx);

      const slugs = await institutionSlugsIn(tx);
      expect(slugs).not.toContain(personal.slug);
      expect(slugs).toContain(organizer.slug);
    });
  });
});
