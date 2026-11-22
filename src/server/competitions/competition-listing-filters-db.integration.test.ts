// @vitest-environment node
//
// THE LOCATION AND AUDIENCE FILTERS OF THE PUBLIC LIST, AGAINST A REAL POSTGRES.
//
// The matching rules are SQL (an IN list, an array overlap), so a mocked database could not tell a
// right rule from a wrong one. These tests insert competitions with every combination the rules
// distinguish, ask the real listing service and the real API route, and compare the titles that
// come back. Every test runs inside a transaction that is always rolled back.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitions,
  institutions,
  type CompetitionAudience,
  type CompetitionLocation,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import type { PublicListingFilters } from "@/server/competitions/competition-public-service";

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
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

// Hoisted for the reason the readiness suite gives: the auth adapter calls `getDb()` while this
// file's own imports are still being evaluated.
const routeState = vi.hoisted(() => ({
  transaction: null as Database | null,
  testRunStarted: false,
}));

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    getDb: () => {
      if (routeState.transaction) return routeState.transaction;
      if (!routeState.testRunStarted) return actual.getDb();
      throw new Error("the list route read the database outside a test");
    },
  };
});

import { GET as listCompetitionsRoute } from "@/app/api/v1/competitions/route";
import { listPublicCompetitions } from "@/server/competitions/competition-public-service";

beforeAll(() => {
  routeState.testRunStarted = true;
});

beforeEach(() => {
  routeState.transaction = null;
});

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;

type Row = {
  title: string;
  location: CompetitionLocation | null;
  audience: CompetitionAudience[] | null;
  status?: "draft" | "published";
  deleted?: boolean;
};

const ROWS: Row[] = [
  { title: "A online mahasiswa", location: "online", audience: ["mahasiswa"] },
  { title: "B offline mahasiswa smp", location: "offline", audience: ["mahasiswa", "smp"] },
  { title: "C hybrid umum", location: "hybrid", audience: ["umum"] },
  { title: "D online sd", location: "online", audience: ["sd"] },
  { title: "E belum diisi", location: null, audience: null },
  { title: "F draft", location: "online", audience: ["mahasiswa"], status: "draft" },
  { title: "G dihapus", location: "online", audience: ["mahasiswa"], deleted: true },
];

const LIVE_TITLES = [
  "A online mahasiswa",
  "B offline mahasiswa smp",
  "C hybrid umum",
  "D online sd",
  "E belum diisi",
];

type Seed = { institutionSlug: string };

const seedInstitution = async (
  tx: Tx,
  suspended: boolean,
): Promise<{ id: string; slug: string }> => {
  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `listing-filter-inst-${uniqueSuffix()}`,
      institutionType: "company",
      displayName: "Penyaring daftar",
      verificationStatus: "verified",
      suspendedAt: suspended ? new Date() : null,
      suspensionReason: suspended ? "integration fixture" : null,
    })
    .returning({ id: institutions.id, slug: institutions.slug });
  return { id: institution!.id, slug: institution!.slug };
};

const seedRows = async (tx: Tx, institutionId: string): Promise<void> => {
  const now = Date.now();
  for (const row of ROWS) {
    await tx.insert(competitions).values({
      institutionId,
      slug: `listing-filter-comp-${uniqueSuffix()}`,
      title: row.title,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "individual",
      location: row.location,
      audience: row.audience,
      status: row.status ?? "published",
      publishedAt: new Date(now),
      deletedAt: row.deleted ? new Date(now) : null,
      registrationStartAt: new Date(now - 7 * DAY_MS),
      registrationEndAt: new Date(now + 14 * DAY_MS),
      eventStartAt: new Date(now + 30 * DAY_MS),
      eventEndAt: new Date(now + 31 * DAY_MS),
    });
  }
};

const seedListing = async (tx: Tx): Promise<Seed> => {
  const institution = await seedInstitution(tx, false);
  await seedRows(tx, institution.id);
  return { institutionSlug: institution.slug };
};

const titlesFor = async (tx: Tx, seed: Seed, filters: PublicListingFilters): Promise<string[]> => {
  const result = await listPublicCompetitions(
    { ...filters, institutionSlug: seed.institutionSlug, limit: 50 },
    tx as unknown as Database,
  );
  return result.data.map((item) => item.title).sort();
};

const MATCHING_CASES: Array<[string, PublicListingFilters, string[]]> = [
  ["no filter shows every live competition, empty ones included", {}, LIVE_TITLES],
  ["online shows online only", { location: "online" }, ["A online mahasiswa", "D online sd"]],
  ["offline shows offline only", { location: "offline" }, ["B offline mahasiswa smp"]],
  ["hybrid shows hybrid only", { location: "hybrid" }, ["C hybrid umum"]],
  ["an unknown location is ignored", { location: "mars" }, LIVE_TITLES],
  ["a location in the wrong case is ignored", { location: "Online" }, LIVE_TITLES],
  [
    "mahasiswa shows mahasiswa and umum",
    { audience: "mahasiswa" },
    ["A online mahasiswa", "B offline mahasiswa smp", "C hybrid umum"],
  ],
  ["smp shows smp and umum", { audience: "smp" }, ["B offline mahasiswa smp", "C hybrid umum"]],
  [
    "two ticked levels show either, and umum",
    { audience: "smp,sd" },
    ["B offline mahasiswa smp", "C hybrid umum", "D online sd"],
  ],
  ["umum alone narrows nothing", { audience: "umum" }, LIVE_TITLES],
  ["only unknown values narrow nothing", { audience: "mars,dosen" }, LIVE_TITLES],
  [
    "an unknown value beside a known one is dropped",
    { audience: "mars,mahasiswa" },
    ["A online mahasiswa", "B offline mahasiswa smp", "C hybrid umum"],
  ],
  [
    "a location and an audience both apply",
    { location: "online", audience: "mahasiswa" },
    ["A online mahasiswa"],
  ],
];

describe.skipIf(skipWithoutDatabase)("the location and audience filters of the list", () => {
  it.each(MATCHING_CASES)("%s", async (_name, filters, expected) => {
    await inRollback(async (tx) => {
      const seed = await seedListing(tx);

      expect(await titlesFor(tx, seed, filters)).toEqual([...expected].sort());
    });
  });

  it.each(["online", "offline", "hybrid"])(
    "never shows a competition with no location under %s",
    async (location) => {
      await inRollback(async (tx) => {
        const seed = await seedListing(tx);

        const titles = await titlesFor(tx, seed, { location });

        expect(titles).not.toContain("E belum diisi");
      });
    },
  );

  it("never shows a draft or a deleted competition because a filter matches it", async () => {
    await inRollback(async (tx) => {
      const seed = await seedListing(tx);

      const titles = await titlesFor(tx, seed, { location: "online", audience: "mahasiswa" });

      expect(titles).not.toContain("F draft");
      expect(titles).not.toContain("G dihapus");
    });
  });

  it("never shows the competitions of a suspended institution because a filter matches them", async () => {
    await inRollback(async (tx) => {
      const suspended = await seedInstitution(tx, true);
      await seedRows(tx, suspended.id);

      const titles = await titlesFor(
        tx,
        { institutionSlug: suspended.slug },
        { location: "online", audience: "mahasiswa" },
      );

      expect(titles).toEqual([]);
    });
  });

  it("does not throw for a raw value that is no enum member", async () => {
    await inRollback(async (tx) => {
      const seed = await seedListing(tx);

      const titles = await titlesFor(tx, seed, {
        location: "online'; drop table competitions; --",
        audience: "foo,'bar,{baz}",
      });

      expect(titles).toEqual([...LIVE_TITLES].sort());
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the list API route", () => {
  const askRoute = async (tx: Tx, seed: Seed, query: string) => {
    routeState.transaction = tx as unknown as Database;
    const response = await listCompetitionsRoute(
      new Request(
        `https://lombakita.test/api/v1/competitions?institutionSlug=${seed.institutionSlug}&limit=50&${query}`,
      ),
    );
    const body = (await response.json()) as { data?: Array<{ title: string }> };
    return { status: response.status, titles: (body.data ?? []).map((item) => item.title).sort() };
  };

  it("reads the location and the audience from the address", async () => {
    await inRollback(async (tx) => {
      const seed = await seedListing(tx);

      const answer = await askRoute(tx, seed, "location=online&audience=mahasiswa");

      expect(answer).toEqual({ status: 200, titles: ["A online mahasiswa"] });
    });
  });

  it("answers 200 and ignores a location and an audience that are not enum members", async () => {
    await inRollback(async (tx) => {
      const seed = await seedListing(tx);

      const answer = await askRoute(tx, seed, "location=mars&audience=foo");

      expect(answer).toEqual({ status: 200, titles: [...LIVE_TITLES].sort() });
    });
  });

  it("takes the first value of a repeated location parameter", async () => {
    await inRollback(async (tx) => {
      const seed = await seedListing(tx);

      const answer = await askRoute(tx, seed, "location=hybrid&location=online");

      expect(answer).toEqual({ status: 200, titles: ["C hybrid umum"] });
    });
  });
});
