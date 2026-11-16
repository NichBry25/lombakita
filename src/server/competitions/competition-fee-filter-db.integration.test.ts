// @vitest-environment node
//
// THE FEE FILTER OF THE PUBLIC LIST, AGAINST A REAL POSTGRES.
//
// Free and paid are SQL over a bigint column, and what counts as paid is decided in TypeScript by
// isPaidCompetition. A mocked database cannot hold 9007199254740992, has no NULL or bigint
// semantics, and would only prove the builder against a reader written for the test. These tests
// insert competitions with every fee the rule distinguishes, ask the real listing service and the
// real API route, and compare what comes back with isPaidCompetition applied to the value read
// back from the table. Every test runs inside a transaction that is always rolled back.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import { competitions, institutions } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import type { Database } from "@/server/db/client";
import type {
  PublicCompetitionItem,
  PublicListingFilters,
} from "@/server/competitions/competition-public-service";

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

type FeeRow = {
  label: string;
  feeAmount: number | null;
  feeCurrency: string | null;
};

// Every fee the rule distinguishes. The last IDR value is one above Number.MAX_SAFE_INTEGER, which
// Postgres stores exactly and JavaScript reads back as an unsafe number. The currency CHECK only
// asks for three capital letters, so a paid fee in another currency can be stored.
const LIVE_FEE_ROWS: FeeRow[] = [
  { label: "null", feeAmount: null, feeCurrency: null },
  { label: "0 IDR", feeAmount: 0, feeCurrency: "IDR" },
  { label: "1", feeAmount: 1, feeCurrency: "IDR" },
  { label: "25000", feeAmount: 25_000, feeCurrency: "IDR" },
  { label: "100000", feeAmount: 100_000, feeCurrency: "IDR" },
  { label: "150000", feeAmount: 150_000, feeCurrency: "IDR" },
  { label: "200000", feeAmount: 200_000, feeCurrency: "IDR" },
  { label: "250000", feeAmount: 250_000, feeCurrency: "IDR" },
  { label: "300000", feeAmount: 300_000, feeCurrency: "IDR" },
  { label: "9007199254740991", feeAmount: 9_007_199_254_740_991, feeCurrency: "IDR" },
  { label: "9007199254740992", feeAmount: 9_007_199_254_740_992, feeCurrency: "IDR" },
  { label: "100000 USD", feeAmount: 100_000, feeCurrency: "USD" },
];

const FREE_LABELS = ["null", "0 IDR", "9007199254740992"];

const PAID_LABELS = [
  "1",
  "25000",
  "100000",
  "150000",
  "200000",
  "250000",
  "300000",
  "9007199254740991",
  "100000 USD",
];

const ALL_LABELS = LIVE_FEE_ROWS.map((row) => row.label);

const liveTitleOf = (label: string): string => `live ${label}`;

const liveTitlesOf = (labels: string[]): string[] => labels.map(liveTitleOf).sort();

type HiddenRow = {
  title: string;
  feeAmount: number;
  status: "draft" | "published";
  deleted: boolean;
};

// A competition that must never be listed, at a free fee and at a paid fee.
const hiddenRowsFor = (state: "draft" | "deleted" | "suspended"): HiddenRow[] =>
  [0, 150_000].map((feeAmount) => ({
    title: `hidden ${state} ${feeAmount}`,
    feeAmount,
    status: state === "draft" ? "draft" : "published",
    deleted: state === "deleted",
  }));

const HIDDEN_DRAFT_AND_DELETED_TITLES = [...hiddenRowsFor("draft"), ...hiddenRowsFor("deleted")]
  .map((row) => row.title)
  .sort();

const seedInstitution = async (
  tx: Tx,
  suspended: boolean,
): Promise<{ id: string; slug: string }> => {
  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `fee-filter-inst-${uniqueSuffix()}`,
      institutionType: "company",
      displayName: "Penyaring biaya",
      verificationStatus: "verified",
      suspendedAt: suspended ? new Date() : null,
      suspensionReason: suspended ? "integration fixture" : null,
    })
    .returning({ id: institutions.id, slug: institutions.slug });
  return { id: institution!.id, slug: institution!.slug };
};

type CompetitionSeed = {
  title: string;
  feeAmount: number | null;
  feeCurrency: string | null;
  status: "draft" | "published";
  deleted: boolean;
};

const insertCompetition = async (
  tx: Tx,
  institutionId: string,
  seed: CompetitionSeed,
): Promise<void> => {
  const now = Date.now();
  await tx.insert(competitions).values({
    institutionId,
    slug: `fee-filter-comp-${uniqueSuffix()}`,
    title: seed.title,
    description: "Deskripsi kompetisi untuk pengujian.",
    category: "hackathon",
    mode: "individual",
    status: seed.status,
    publishedAt: new Date(now),
    deletedAt: seed.deleted ? new Date(now) : null,
    feeAmount: seed.feeAmount,
    feeCurrency: seed.feeCurrency,
    registrationStartAt: new Date(now - 7 * DAY_MS),
    registrationEndAt: new Date(now + 14 * DAY_MS),
    eventStartAt: new Date(now + 30 * DAY_MS),
    eventEndAt: new Date(now + 31 * DAY_MS),
  });
};

const seedLiveRows = async (tx: Tx, institutionId: string): Promise<void> => {
  for (const row of LIVE_FEE_ROWS) {
    await insertCompetition(tx, institutionId, {
      title: liveTitleOf(row.label),
      feeAmount: row.feeAmount,
      feeCurrency: row.feeCurrency,
      status: "published",
      deleted: false,
    });
  }
};

const seedHiddenRows = async (
  tx: Tx,
  institutionId: string,
  states: Array<"draft" | "deleted" | "suspended">,
): Promise<void> => {
  for (const state of states) {
    for (const row of hiddenRowsFor(state)) {
      await insertCompetition(tx, institutionId, {
        title: row.title,
        feeAmount: row.feeAmount,
        feeCurrency: row.feeAmount > 0 ? "IDR" : null,
        status: row.status,
        deleted: row.deleted,
      });
    }
  }
};

type Seed = { institutionId: string; institutionSlug: string };

const seedFeeListing = async (tx: Tx): Promise<Seed> => {
  const institution = await seedInstitution(tx, false);
  await seedLiveRows(tx, institution.id);
  await seedHiddenRows(tx, institution.id, ["draft", "deleted"]);
  return { institutionId: institution.id, institutionSlug: institution.slug };
};

const listItemsFor = async (
  tx: Tx,
  institutionSlug: string,
  filters: PublicListingFilters,
): Promise<PublicCompetitionItem[]> => {
  const result = await listPublicCompetitions(
    { ...filters, institutionSlug, limit: 50 },
    tx as unknown as Database,
  );
  return result.data;
};

const titlesFor = async (
  tx: Tx,
  institutionSlug: string,
  filters: PublicListingFilters,
): Promise<string[]> => {
  const items = await listItemsFor(tx, institutionSlug, filters);
  return items.map((item) => item.title).sort();
};

// The fee as the application reads it back, which is the value isPaidCompetition is given.
const readBackFees = async (tx: Tx, institutionId: string) =>
  tx
    .select({ title: competitions.title, feeAmount: competitions.feeAmount })
    .from(competitions)
    .where(eq(competitions.institutionId, institutionId));

describe.skipIf(skipWithoutDatabase)("the fee filter agrees with isPaidCompetition", () => {
  it("puts every stored fee in exactly the one list that isPaidCompetition picks", async () => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);
      const stored = (await readBackFees(tx, seed.institutionId)).filter((row) =>
        row.title.startsWith("live "),
      );
      const paidTitles = await titlesFor(tx, seed.institutionSlug, { fee: "paid" });
      const freeTitles = await titlesFor(tx, seed.institutionSlug, { fee: "free" });

      expect(stored).toHaveLength(LIVE_FEE_ROWS.length);
      for (const row of stored) {
        const isPaid = isPaidCompetition(row.feeAmount);
        expect(paidTitles.includes(row.title), `${row.title} in the paid list`).toBe(isPaid);
        expect(freeTitles.includes(row.title), `${row.title} in the free list`).toBe(!isPaid);
      }
      expect(paidTitles.length + freeTitles.length).toBe(LIVE_FEE_ROWS.length);
    });
  });

  it("reads the unsafe value back as unsafe, so the test reaches the case it exists for", async () => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);
      const stored = await readBackFees(tx, seed.institutionId);

      const unsafe = stored.find((row) => row.title === liveTitleOf("9007199254740992"));
      const safe = stored.find((row) => row.title === liveTitleOf("9007199254740991"));

      expect(Number.isSafeInteger(unsafe!.feeAmount)).toBe(false);
      expect(isPaidCompetition(unsafe!.feeAmount)).toBe(false);
      expect(Number.isSafeInteger(safe!.feeAmount)).toBe(true);
      expect(isPaidCompetition(safe!.feeAmount)).toBe(true);
    });
  });

  it("lists null, a zero fee and an unsafe fee as free, and every other fee as paid", async () => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);

      expect(await titlesFor(tx, seed.institutionSlug, { fee: "free" })).toEqual(
        liveTitlesOf(FREE_LABELS),
      );
      expect(await titlesFor(tx, seed.institutionSlug, { fee: "paid" })).toEqual(
        liveTitlesOf(PAID_LABELS),
      );
    });
  });
});

const RANGE_CASES: Array<[string, PublicListingFilters, string[]]> = [
  ["no fee filter shows every live competition", {}, ALL_LABELS],
  [
    "Rp 0 to Rp 25.000 never matches a zero IDR fee",
    { fee: "paid", feeMax: "25000" },
    ["1", "25000"],
  ],
  [
    "Rp 100.000 to Rp 200.000 includes both ends and leaves out a paid fee in another currency",
    { fee: "paid", feeMin: "100000", feeMax: "200000" },
    ["100000", "150000", "200000"],
  ],
  [
    "feeMax 250000 has no upper limit",
    { fee: "paid", feeMin: "200000", feeMax: "250000" },
    ["200000", "250000", "300000", "9007199254740991"],
  ],
  [
    "an absent feeMax has no upper limit",
    { fee: "paid", feeMin: "200000" },
    ["200000", "250000", "300000", "9007199254740991"],
  ],
  [
    "a lower end at the top of the track still includes 300000",
    { fee: "paid", feeMin: "250000" },
    ["250000", "300000", "9007199254740991"],
  ],
  [
    "an absent feeMin starts below every paid fee",
    { fee: "paid", feeMax: "100000" },
    ["1", "25000", "100000"],
  ],
  [
    "the whole track is paid alone, in every currency",
    { fee: "paid", feeMin: "0", feeMax: "250000" },
    PAID_LABELS,
  ],
  [
    "a reversed range is read with the lower end pulled down",
    { fee: "paid", feeMin: "200000", feeMax: "100000" },
    ["100000"],
  ],
  [
    "an off-step feeMin and a feeMax of 0 are ignored",
    { fee: "paid", feeMin: "30000", feeMax: "0" },
    PAID_LABELS,
  ],
  [
    "an unreadable feeMin and a feeMax past the track are ignored",
    { fee: "paid", feeMin: "abc", feeMax: "999999999999999999999" },
    PAID_LABELS,
  ],
  ["free ignores the two ends", { fee: "free", feeMin: "100000", feeMax: "200000" }, FREE_LABELS],
  ["the two ends without fee=paid are ignored", { feeMin: "100000", feeMax: "200000" }, ALL_LABELS],
  ["an unknown fee is ignored", { fee: "both" }, ALL_LABELS],
  ["a fee in the wrong case is ignored", { fee: "FREE" }, ALL_LABELS],
];

describe.skipIf(skipWithoutDatabase)("the paid range", () => {
  it.each(RANGE_CASES)("%s", async (_name, filters, expectedLabels) => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);

      expect(await titlesFor(tx, seed.institutionSlug, filters)).toEqual(
        liveTitlesOf(expectedLabels),
      );
    });
  });

  it("does not throw for a raw value that is no fee", async () => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);

      const titles = await titlesFor(tx, seed.institutionSlug, {
        fee: "paid'; drop table competitions; --",
        feeMin: "1 or 1=1",
        feeMax: "'; --",
      });

      expect(titles).toEqual(liveTitlesOf(ALL_LABELS));
    });
  });
});

const FEE_FILTERS_THAT_MATCH_SOMETHING: PublicListingFilters[] = [
  { fee: "free" },
  { fee: "paid" },
  { fee: "paid", feeMax: "25000" },
  { fee: "paid", feeMin: "100000", feeMax: "200000" },
  { fee: "paid", feeMin: "200000" },
];

describe.skipIf(skipWithoutDatabase)("the fee filter and what is publicly visible", () => {
  it("never shows a draft or a deleted competition under free, paid or a range", async () => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);
      const stored = await readBackFees(tx, seed.institutionId);
      const hiddenTitles = stored
        .map((row) => row.title)
        .filter((title) => title.startsWith("hidden "))
        .sort();
      expect(hiddenTitles).toEqual(HIDDEN_DRAFT_AND_DELETED_TITLES);

      for (const filters of FEE_FILTERS_THAT_MATCH_SOMETHING) {
        const titles = await titlesFor(tx, seed.institutionSlug, filters);
        const shownHidden = titles.filter((title) => title.startsWith("hidden "));
        expect(shownHidden, JSON.stringify(filters)).toEqual([]);
      }
    });
  });

  it("never shows the competitions of a suspended institution under free, paid or a range", async () => {
    await inRollback(async (tx) => {
      const suspended = await seedInstitution(tx, true);
      await seedHiddenRows(tx, suspended.id, ["suspended"]);
      await seedLiveRows(tx, suspended.id);

      for (const filters of FEE_FILTERS_THAT_MATCH_SOMETHING) {
        expect(await titlesFor(tx, suspended.slug, filters), JSON.stringify(filters)).toEqual([]);
      }
    });
  });
});

const hasMoneyField = (item: object): boolean =>
  Object.keys(item).some((key) => /fee|currency|amount/i.test(key));

describe.skipIf(skipWithoutDatabase)("the list shows no fee", () => {
  it("adds no fee or currency field to a list item, under any fee filter", async () => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);

      for (const filters of [{}, ...FEE_FILTERS_THAT_MATCH_SOMETHING]) {
        const items = await listItemsFor(tx, seed.institutionSlug, filters);
        expect(items.length, JSON.stringify(filters)).toBeGreaterThan(0);
        expect(items.some(hasMoneyField), JSON.stringify(filters)).toBe(false);
      }
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the list API route and the fee filter", () => {
  const askRoute = async (tx: Tx, institutionSlug: string, query: string) => {
    routeState.transaction = tx as unknown as Database;
    const response = await listCompetitionsRoute(
      new Request(
        `https://lombakita.test/api/v1/competitions?institutionSlug=${institutionSlug}&limit=50&${query}`,
      ),
    );
    const body = (await response.json()) as { data?: Array<{ title: string }> };
    const items = body.data ?? [];
    return {
      status: response.status,
      titles: items.map((item) => item.title).sort(),
      hasMoneyField: items.some(hasMoneyField),
    };
  };

  it("reads the fee and its two ends from the address", async () => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);

      const answer = await askRoute(
        tx,
        seed.institutionSlug,
        "fee=paid&feeMin=100000&feeMax=200000",
      );

      expect(answer).toEqual({
        status: 200,
        titles: liveTitlesOf(["100000", "150000", "200000"]),
        hasMoneyField: false,
      });
    });
  });

  it("answers free with the free list", async () => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);

      const answer = await askRoute(tx, seed.institutionSlug, "fee=free");

      expect(answer.titles).toEqual(liveTitlesOf(FREE_LABELS));
    });
  });

  it("answers 200 and ignores a fee, a feeMin and a feeMax that are not on the track", async () => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);

      const answer = await askRoute(tx, seed.institutionSlug, "fee=paid&feeMin=abc&feeMax=1e9");

      expect(answer).toEqual({
        status: 200,
        titles: liveTitlesOf(PAID_LABELS),
        hasMoneyField: false,
      });
    });
  });

  it("takes the first value of a repeated fee parameter", async () => {
    await inRollback(async (tx) => {
      const seed = await seedFeeListing(tx);

      const answer = await askRoute(tx, seed.institutionSlug, "fee=free&fee=paid");

      expect(answer.titles).toEqual(liveTitlesOf(FREE_LABELS));
    });
  });
});
