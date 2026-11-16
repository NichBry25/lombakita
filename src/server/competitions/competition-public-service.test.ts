// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import type { PublicCompetitionItem } from "@/server/competitions/competition-public-service";

// Meilisearch is stubbed out for all DB-path tests.
vi.mock("@/server/search/availability", () => ({ isMeilisearchAvailable: vi.fn(() => false) }));
vi.mock("@/server/search/client", () => ({ getMeilisearchClient: vi.fn() }));

// Signing is stubbed at the storage client so the real key resolution and signing wrapper run.
vi.mock("@/server/storage/r2.client", () => ({
  isR2Available: vi.fn(() => true),
  generatePresignedGetUrl: vi.fn(
    async (key: string, expirySeconds: number) =>
      `https://files.test/${key}?expires=${expirySeconds}`,
  ),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  listPublicCompetitions,
  listFeaturedCompetitions,
  deriveCTAState,
  resolveUseSearch,
  countPublicRegistrants,
} from "@/server/competitions/competition-public-service";
import { generatePresignedGetUrl, isR2Available } from "@/server/storage/r2.client";
import { logger } from "@/lib/logger";

// The service maps the joined institution columns (display_name / type / owner-username) through
// getInstitutionDisplayName, so the mocked DB rows carry the RAW projection shape, not the resolved
// output shape. institutionName on the result is computed, never read straight from the row, and
// institutionLogoUrl is signed from the two key columns.
type RawListingRow = Omit<PublicCompetitionItem, "institutionName" | "institutionLogoUrl"> & {
  institutionLogoR2Key: string | null;
  institutionOwnerAvatarKey: string | null;
  institutionDisplayName: string | null;
  institutionType:
    | "personal"
    | "company"
    | "foundation"
    | "university"
    | "campus_organization"
    | null;
  institutionOwnerUsername: string | null;
};

// Builds a chainable Drizzle mock where:
//   first db.select() → resolves rows after full chain .from().innerJoin().where().orderBy().limit().offset()
//   second db.select() → resolves count array after .from().innerJoin().where()
const makeDb = (rows: RawListingRow[], total: number): Database => {
  const rowsChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue(rows),
  };
  const countChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ count: total }]),
  };
  let callIdx = 0;
  return {
    select: vi.fn(() => (callIdx++ === 0 ? rowsChain : countChain)),
  } as unknown as Database;
};

const makeRow = (overrides: Partial<RawListingRow> = {}): RawListingRow => ({
  id: "comp_1",
  slug: "lomba-x",
  title: "Lomba X",
  description: "Deskripsi",
  category: "hackathon",
  mode: "individual",
  minTeamSize: null,
  maxTeamSize: null,
  registrationStartAt: null,
  registrationEndAt: null,
  eventStartAt: null,
  eventEndAt: null,
  resultAnnouncementAt: null,
  cancelledAt: null,
  hasPublishedResult: false,
  publishedAt: new Date("2026-05-01"),
  createdAt: new Date("2026-05-01"),
  updatedAt: new Date("2026-05-01"),
  isFeatured: false,
  institutionSlug: "lk-univ",
  institutionDisplayName: "Universitas LK",
  institutionType: null,
  institutionOwnerUsername: null,
  institutionLogoR2Key: null,
  institutionOwnerAvatarKey: null,
  ...overrides,
});

describe("listPublicCompetitions — DB path", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns data + meta shape with searchEngine db", async () => {
    const db = makeDb([makeRow()], 1);
    const result = await listPublicCompetitions({}, db);

    expect(result.data).toHaveLength(1);
    expect(result.meta.searchEngine).toBe("db");
    expect(result.meta.total).toBe(1);
    expect(result.meta.page).toBe(1);
  });

  it("resolves a full institution's stored name as the organizer name", async () => {
    const db = makeDb([makeRow()], 1);
    const result = await listPublicCompetitions({}, db);
    expect(result.data[0]!.institutionName).toBe("Universitas LK");
  });

  it("derives a personal institution's organizer name from the owner username", async () => {
    const personalRow = makeRow({
      institutionDisplayName: null,
      institutionType: "personal",
      institutionOwnerUsername: "owneruser",
    });
    const db = makeDb([personalRow], 1);
    const result = await listPublicCompetitions({}, db);
    expect(result.data[0]!.institutionName).toBe("owneruser's Institution");
  });

  it("defaults page to 1 and limit to 20", async () => {
    const db = makeDb([], 0);
    const result = await listPublicCompetitions({}, db);
    expect(result.meta.page).toBe(1);
    expect(result.meta.limit).toBe(20);
  });

  it("clamps limit to 50 when caller requests higher", async () => {
    const db = makeDb([], 0);
    const result = await listPublicCompetitions({ limit: 999 }, db);
    expect(result.meta.limit).toBe(50);
  });

  it("computes totalPages correctly", async () => {
    const db = makeDb([], 45);
    const result = await listPublicCompetitions({ limit: 20 }, db);
    expect(result.meta.totalPages).toBe(3); // ceil(45/20) = 3
  });

  it("returns empty data array when no competitions exist", async () => {
    const db = makeDb([], 0);
    const result = await listPublicCompetitions({}, db);
    expect(result.data).toHaveLength(0);
    expect(result.meta.total).toBe(0);
  });

  it("passes page and resolves correct meta.page", async () => {
    const db = makeDb([], 60);
    const result = await listPublicCompetitions({ page: 3, limit: 20 }, db);
    expect(result.meta.page).toBe(3);
    expect(result.meta.totalPages).toBe(3);
  });

  // A page number this large reached Postgres as an OFFSET past what bigint can hold and the
  // public listing answered 500 — measured live at page=99999999999999999999 both here and on
  // /api/v1/competitions, since both call through this same function. `Number.isFinite` does not
  // catch it: `Number.parseInt("99999999999999999999", 10)` returns a huge but FINITE number, it
  // only loses precision. The clamp is what stops it, not the finiteness check.
  it("clamps an absurdly large page to a bounded result instead of erroring", async () => {
    const db = makeDb([], 0);
    const result = await listPublicCompetitions(
      { page: 99_999_999_999_999_999_999, limit: 20 },
      db,
    );

    expect(result.meta.page).toBe(100_000);
    expect(Number.isSafeInteger(result.meta.page)).toBe(true);
  });

  it("keeps the offset passed to the database within a safe integer range for the same input", async () => {
    const rowsChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockResolvedValue([]),
    };
    const countChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ count: 0 }]),
    };
    let callIdx = 0;
    const db = {
      select: vi.fn(() => (callIdx++ === 0 ? rowsChain : countChain)),
    } as unknown as Database;

    await listPublicCompetitions({ page: 99_999_999_999_999_999_999, limit: 50 }, db);

    const offsetPassed = rowsChain.offset.mock.calls[0]?.[0];
    expect(Number.isSafeInteger(offsetPassed)).toBe(true);
    expect(offsetPassed).toBe((100_000 - 1) * 50);
  });
});

describe("listPublicCompetitions — Meilisearch degradation", () => {
  afterEach(() => vi.clearAllMocks());

  it("falls back to DB when Meilisearch throws at runtime", async () => {
    const { isMeilisearchAvailable } = await import("@/server/search/availability");
    vi.mocked(isMeilisearchAvailable).mockReturnValue(true);

    const { getMeilisearchClient } = await import("@/server/search/client");
    vi.mocked(getMeilisearchClient).mockReturnValue({
      index: () => ({
        search: vi.fn().mockRejectedValue(new Error("connection refused")),
      }),
    } as unknown as ReturnType<typeof getMeilisearchClient>);

    const db = makeDb([makeRow()], 1);
    const result = await listPublicCompetitions({ q: "lomba" }, db);

    // Falls back to DB — searchEngine must be "db"
    expect(result.meta.searchEngine).toBe("db");
    expect(result.data).toHaveLength(1);
  });
});

// Builds a DB mock for the Meilisearch hydration path.
// listFromMeilisearch issues a single db.select() that terminates at .where() — no orderBy/limit/offset.
const makeHydrationDb = (rows: RawListingRow[]): Database =>
  ({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  }) as unknown as Database;

// DB mock for the Meili-hits-fail-hydration fallthrough: 1st select() serves the Meili
// hydration (from→innerJoin→where), 2nd serves listFromDb rows
// (from→innerJoin→where→orderBy→limit→offset), 3rd serves the count (from→innerJoin→where).
const makeMeiliThenDbMock = (
  hydrationRows: RawListingRow[],
  dbRows: RawListingRow[],
  total: number,
): Database => {
  const hydrationChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(hydrationRows),
  };
  const rowsChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue(dbRows),
  };
  const countChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ count: total }]),
  };
  const chains = [hydrationChain, rowsChain, countChain];
  let idx = 0;
  return { select: vi.fn(() => chains[idx++]) } as unknown as Database;
};

describe("listPublicCompetitions — Meilisearch happy path", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns results in Meilisearch relevance order, not DB row order", async () => {
    const { isMeilisearchAvailable } = await import("@/server/search/availability");
    vi.mocked(isMeilisearchAvailable).mockReturnValue(true);

    // Meilisearch returns comp_2 first (higher relevance), then comp_1.
    const { getMeilisearchClient } = await import("@/server/search/client");
    vi.mocked(getMeilisearchClient).mockReturnValue({
      index: () => ({
        search: vi.fn().mockResolvedValue({
          hits: [{ id: "comp_2" }, { id: "comp_1" }],
          estimatedTotalHits: 2,
        }),
      }),
    } as unknown as ReturnType<typeof getMeilisearchClient>);

    // DB hydration returns rows in a different order (comp_1 first, as returned by inArray query).
    const row1 = makeRow({ id: "comp_1", title: "Lomba A", slug: "lomba-a" });
    const row2 = makeRow({ id: "comp_2", title: "Lomba B", slug: "lomba-b" });
    const db = makeHydrationDb([row1, row2]);

    const result = await listPublicCompetitions({ q: "lomba" }, db);

    expect(result.meta.searchEngine).toBe("meilisearch");
    expect(result.data).toHaveLength(2);
    // Response must follow Meilisearch order: comp_2 before comp_1.
    expect(result.data[0]!.id).toBe("comp_2");
    expect(result.data[1]!.id).toBe("comp_1");
  });

  it("excludes stale Meilisearch IDs that are no longer published in DB (stale-index safety net)", async () => {
    const { isMeilisearchAvailable } = await import("@/server/search/availability");
    vi.mocked(isMeilisearchAvailable).mockReturnValue(true);

    // Meilisearch returns two IDs — comp_1 is stale (unpublished since indexing).
    const { getMeilisearchClient } = await import("@/server/search/client");
    vi.mocked(getMeilisearchClient).mockReturnValue({
      index: () => ({
        search: vi.fn().mockResolvedValue({
          hits: [{ id: "comp_1" }, { id: "comp_2" }],
          estimatedTotalHits: 2,
        }),
      }),
    } as unknown as ReturnType<typeof getMeilisearchClient>);

    // DB hydration only returns comp_2 — comp_1 is no longer status=published, so the
    // DB re-guard filters it out and it is absent from the hydration result set.
    const row2 = makeRow({ id: "comp_2", title: "Lomba B", slug: "lomba-b" });
    const db = makeHydrationDb([row2]);

    const result = await listPublicCompetitions({ q: "lomba" }, db);

    expect(result.meta.searchEngine).toBe("meilisearch");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.id).toBe("comp_2");
  });
});

describe("resolveUseSearch — Meili routing (spec §6)", () => {
  it("uses search when q present, meili available, and no new filters", () => {
    expect(resolveUseSearch({ q: "lomba" }, true)).toBe(true);
  });

  it("forces DB path when status is active", () => {
    expect(resolveUseSearch({ q: "lomba", status: "closed" }, true)).toBe(false);
  });

  it("forces DB path when teamSize is active", () => {
    expect(resolveUseSearch({ q: "lomba", teamSize: "small" }, true)).toBe(false);
  });

  it("does not use search when meili unavailable", () => {
    expect(resolveUseSearch({ q: "lomba" }, false)).toBe(false);
  });

  it("does not use search when q is absent", () => {
    expect(resolveUseSearch({ category: "hackathon" }, true)).toBe(false);
  });

  it("treats empty-string status/teamSize as absent", () => {
    expect(resolveUseSearch({ q: "lomba", status: "", teamSize: "" }, true)).toBe(true);
  });

  it("does not use search for a token-less query (punctuation only)", () => {
    expect(resolveUseSearch({ q: ";" }, true)).toBe(false);
    expect(resolveUseSearch({ q: "  " }, true)).toBe(false);
    expect(resolveUseSearch({ q: "!@#$" }, true)).toBe(false);
  });

  it("uses search for a query that has at least one letter or digit", () => {
    expect(resolveUseSearch({ q: "a" }, true)).toBe(true);
    expect(resolveUseSearch({ q: "2026" }, true)).toBe(true);
  });
});

describe("listPublicCompetitions — token-less query never hits Meilisearch", () => {
  afterEach(() => vi.clearAllMocks());

  it("routes a punctuation-only query to the DB path even when Meili is available", async () => {
    const { isMeilisearchAvailable } = await import("@/server/search/availability");
    vi.mocked(isMeilisearchAvailable).mockReturnValue(true);

    const { getMeilisearchClient } = await import("@/server/search/client");
    const getClient = vi.mocked(getMeilisearchClient);

    const db = makeDb([], 0);
    const result = await listPublicCompetitions({ q: ";" }, db);

    expect(result.meta.searchEngine).toBe("db");
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("listPublicCompetitions — status/teamSize force the DB path", () => {
  afterEach(() => vi.clearAllMocks());

  it("uses the DB path (not Meilisearch) when a status filter is active, even with q", async () => {
    const { isMeilisearchAvailable } = await import("@/server/search/availability");
    vi.mocked(isMeilisearchAvailable).mockReturnValue(true);

    const { getMeilisearchClient } = await import("@/server/search/client");
    const getClient = vi.mocked(getMeilisearchClient);

    const db = makeDb([makeRow()], 1);
    const result = await listPublicCompetitions({ q: "lomba", status: "closed" }, db);

    expect(result.meta.searchEngine).toBe("db");
    expect(getClient).not.toHaveBeenCalled();
  });

  it("uses the DB path when a teamSize filter is active, even with q", async () => {
    const { isMeilisearchAvailable } = await import("@/server/search/availability");
    vi.mocked(isMeilisearchAvailable).mockReturnValue(true);

    const { getMeilisearchClient } = await import("@/server/search/client");
    const getClient = vi.mocked(getMeilisearchClient);

    const db = makeDb([makeRow()], 1);
    const result = await listPublicCompetitions({ q: "lomba", teamSize: "small" }, db);

    expect(result.meta.searchEngine).toBe("db");
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("countPublicRegistrants", () => {
  afterEach(() => vi.clearAllMocks());

  const makeCountDb = (rows: Array<{ count: number }>): Database =>
    ({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }) as unknown as Database;

  it("returns the confirmed-registration count", async () => {
    const db = makeCountDb([{ count: 42 }]);
    expect(await countPublicRegistrants("comp_1", db)).toBe(42);
  });

  it("returns 0 when the count query yields no row", async () => {
    const db = makeCountDb([]);
    expect(await countPublicRegistrants("comp_1", db)).toBe(0);
  });
});

describe("deriveCTAState", () => {
  const past = new Date("2026-04-01T00:00:00Z");
  const future = new Date("2026-09-01T00:00:00Z");
  const now = new Date("2026-05-09T12:00:00Z");

  it("returns not_yet_open when now is before registration window", () => {
    expect(deriveCTAState(future, new Date("2026-10-01T00:00:00Z"), now)).toBe("not_yet_open");
  });

  it("returns open when now is within registration window", () => {
    expect(deriveCTAState(past, future, now)).toBe("open");
  });

  it("returns closed when now is after registration window", () => {
    expect(deriveCTAState(past, new Date("2026-04-30T00:00:00Z"), now)).toBe("closed");
  });

  it("returns closed when startAt is null", () => {
    expect(deriveCTAState(null, future, now)).toBe("closed");
  });

  it("returns closed when endAt is null", () => {
    expect(deriveCTAState(past, null, now)).toBe("closed");
  });
});

describe("listPublicCompetitions — featured sort", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns isFeatured field on each item", async () => {
    const featuredRow = makeRow({ id: "comp_f", isFeatured: true });
    const regularRow = makeRow({ id: "comp_r", isFeatured: false });
    const db = makeDb([featuredRow, regularRow], 2);
    const result = await listPublicCompetitions({}, db);
    expect(result.data.at(0)?.isFeatured).toBe(true);
    expect(result.data.at(1)?.isFeatured).toBe(false);
  });

  it("featured row appears before non-featured in DB result order", async () => {
    const featuredRow = makeRow({ id: "comp_f", title: "Unggulan", isFeatured: true });
    const regularRow = makeRow({ id: "comp_r", title: "Biasa", isFeatured: false });
    // DB mock returns rows in the order the service query would produce:
    // featured rows first (service passes isFeatured DESC as first orderBy).
    const db = makeDb([featuredRow, regularRow], 2);
    const result = await listPublicCompetitions({}, db);
    expect(result.data.at(0)?.id).toBe("comp_f");
    expect(result.data.at(1)?.id).toBe("comp_r");
  });
});

describe("F15 — deadline filter on Meilisearch path", () => {
  afterEach(() => vi.clearAllMocks());

  it("passes a deadline filter expression to Meilisearch search()", async () => {
    const { isMeilisearchAvailable } = await import("@/server/search/availability");
    vi.mocked(isMeilisearchAvailable).mockReturnValue(true);

    const searchFn = vi.fn().mockResolvedValue({ hits: [{ id: "comp_1" }], estimatedTotalHits: 1 });
    const { getMeilisearchClient } = await import("@/server/search/client");
    vi.mocked(getMeilisearchClient).mockReturnValue({
      index: () => ({ search: searchFn }),
    } as unknown as ReturnType<typeof getMeilisearchClient>);

    const db = makeHydrationDb([makeRow()]);
    await listPublicCompetitions({ q: "lomba" }, db);

    const [, searchOptions] = searchFn.mock.calls[0] as [unknown, { filter: string }];
    // Filter string must reference deadline with a numeric (unquoted) epoch comparison
    // and a null guard so past-deadline and no-deadline competitions are handled correctly.
    expect(searchOptions.filter).toContain("deadline");
    expect(searchOptions.filter).toContain("IS NULL");
    // Deadline stored as epoch seconds — comparison must be unquoted numeric, not ISO string.
    expect(searchOptions.filter).toMatch(/deadline >= \d+/);
  });

  it("featured-but-past-deadline: hydration empties, then falls through to the DB path", async () => {
    const { isMeilisearchAvailable } = await import("@/server/search/availability");
    vi.mocked(isMeilisearchAvailable).mockReturnValue(true);

    // Meilisearch returned a featured competition (stale index, deadline already passed).
    const { getMeilisearchClient } = await import("@/server/search/client");
    vi.mocked(getMeilisearchClient).mockReturnValue({
      index: () => ({
        search: vi
          .fn()
          .mockResolvedValue({ hits: [{ id: "comp_featured_stale" }], estimatedTotalHits: 1 }),
      }),
    } as unknown as ReturnType<typeof getMeilisearchClient>);

    // Meili hydration returns empty (deadline guard removed it); the DB fallthrough also finds
    // nothing. The user must never see a phantom count over an empty grid.
    const db = makeMeiliThenDbMock([], [], 0);
    const result = await listPublicCompetitions({ q: "unggulan" }, db);

    expect(result.meta.searchEngine).toBe("db");
    expect(result.meta.total).toBe(0);
    expect(result.data).toHaveLength(0);
  });

  it("stale-index: a Meili hit that fails hydration falls through to DB and surfaces the live row", async () => {
    const { isMeilisearchAvailable } = await import("@/server/search/availability");
    vi.mocked(isMeilisearchAvailable).mockReturnValue(true);

    // Meilisearch matches by a stale id that no longer hydrates from the DB.
    const { getMeilisearchClient } = await import("@/server/search/client");
    vi.mocked(getMeilisearchClient).mockReturnValue({
      index: () => ({
        search: vi.fn().mockResolvedValue({ hits: [{ id: "stale_id" }], estimatedTotalHits: 1 }),
      }),
    } as unknown as ReturnType<typeof getMeilisearchClient>);

    // Hydration of the stale id returns nothing, but the live row exists in the DB and is found
    // by the literal ILIKE fallthrough.
    const liveRow = makeRow({ id: "live_id", title: "National Business Case Competition" });
    const db = makeMeiliThenDbMock([], [liveRow], 1);
    const result = await listPublicCompetitions({ q: "business case" }, db);

    expect(result.meta.searchEngine).toBe("db");
    expect(result.meta.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.title).toBe("National Business Case Competition");
  });
});

// DB mock for listFeaturedCompetitions: one select that ends at .limit().
const makeFeaturedDb = (rows: RawListingRow[]): Database =>
  ({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    }),
  }) as unknown as Database;

const useMeilisearchHits = async (ids: string[]) => {
  const { isMeilisearchAvailable } = await import("@/server/search/availability");
  vi.mocked(isMeilisearchAvailable).mockReturnValue(true);
  const { getMeilisearchClient } = await import("@/server/search/client");
  vi.mocked(getMeilisearchClient).mockReturnValue({
    index: () => ({
      search: vi.fn().mockResolvedValue({
        hits: ids.map((id) => ({ id })),
        estimatedTotalHits: ids.length,
      }),
    }),
  } as unknown as ReturnType<typeof getMeilisearchClient>);
};

const signedUrlFor = (key: string) => `https://files.test/${key}?expires=3600`;

describe("organiser logo address — database path", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the signed logo address of the institution's own logo", async () => {
    const db = makeDb([makeRow({ institutionLogoR2Key: "logos/lk.png" })], 1);

    const result = await listPublicCompetitions({}, db);

    expect(result.data[0]!.institutionLogoUrl).toBe(signedUrlFor("logos/lk.png"));
  });

  it("returns a personal institution's owner avatar, never its own logo column", async () => {
    const personalRow = makeRow({
      institutionDisplayName: null,
      institutionType: "personal",
      institutionOwnerUsername: "owneruser",
      institutionLogoR2Key: "logos/ignored.png",
      institutionOwnerAvatarKey: "avatars/owner.png",
    });
    const db = makeDb([personalRow], 1);

    const result = await listPublicCompetitions({}, db);

    expect(result.data[0]!.institutionLogoUrl).toBe(signedUrlFor("avatars/owner.png"));
  });

  it("returns null and signs nothing for an institution with no logo", async () => {
    const db = makeDb([makeRow()], 1);

    const result = await listPublicCompetitions({}, db);

    expect(result.data[0]!.institutionLogoUrl).toBeNull();
    expect(generatePresignedGetUrl).not.toHaveBeenCalled();
  });

  it("never puts a storage key on the public item", async () => {
    const db = makeDb(
      [makeRow({ institutionLogoR2Key: "logos/lk.png", institutionOwnerAvatarKey: "a/b.png" })],
      1,
    );

    const result = await listPublicCompetitions({}, db);

    expect(result.data[0]).not.toHaveProperty("institutionLogoR2Key");
    expect(result.data[0]).not.toHaveProperty("institutionOwnerAvatarKey");
  });

  it("reads a page's logo keys in the listing query, not one query per card", async () => {
    const rows = [
      makeRow({ id: "comp_1", institutionLogoR2Key: "logos/a.png" }),
      makeRow({ id: "comp_2", institutionLogoR2Key: "logos/b.png" }),
      makeRow({ id: "comp_3", institutionLogoR2Key: "logos/c.png" }),
    ];
    const db = makeDb(rows, 3);

    await listPublicCompetitions({}, db);

    // The rows query and the count query, and nothing for the logos.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });

  it("signs one address per distinct logo, so one organiser's cards sign once", async () => {
    const rows = [
      makeRow({ id: "comp_1", institutionLogoR2Key: "logos/a.png" }),
      makeRow({ id: "comp_2", institutionLogoR2Key: "logos/a.png" }),
      makeRow({ id: "comp_3", institutionLogoR2Key: "logos/b.png" }),
    ];
    const db = makeDb(rows, 3);

    const result = await listPublicCompetitions({}, db);

    expect(generatePresignedGetUrl).toHaveBeenCalledTimes(2);
    expect(result.data.map((item) => item.institutionLogoUrl)).toEqual([
      signedUrlFor("logos/a.png"),
      signedUrlFor("logos/a.png"),
      signedUrlFor("logos/b.png"),
    ]);
  });

  it("signs for longer than the 300 seconds the home page caches its HTML", async () => {
    const db = makeDb([makeRow({ institutionLogoR2Key: "logos/lk.png" })], 1);

    await listPublicCompetitions({}, db);

    const expirySeconds = vi.mocked(generatePresignedGetUrl).mock.calls[0]![1];
    expect(expirySeconds).toBeGreaterThan(300);
  });

  it("falls back to no logo, and logs it, when a logo cannot be signed", async () => {
    vi.mocked(generatePresignedGetUrl).mockRejectedValueOnce(new Error("sign failed"));
    const rows = [
      makeRow({ id: "comp_1", institutionLogoR2Key: "logos/a.png" }),
      makeRow({ id: "comp_2", institutionLogoR2Key: "logos/b.png" }),
    ];
    const db = makeDb(rows, 2);

    const result = await listPublicCompetitions({}, db);

    expect(result.data).toHaveLength(2);
    const addresses = result.data.map((item) => item.institutionLogoUrl);
    expect(addresses).toContain(null);
    expect(addresses.filter(Boolean)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "institution.media.read-url.failed",
      expect.objectContaining({ error: "sign failed" }),
    );
  });

  it("gives every card no logo, and still returns every row, when the store is unavailable", async () => {
    vi.mocked(isR2Available).mockReturnValue(false);
    const rows = [
      makeRow({ id: "comp_1", institutionLogoR2Key: "logos/a.png" }),
      makeRow({ id: "comp_2", institutionLogoR2Key: "logos/b.png" }),
      makeRow({ id: "comp_3" }),
    ];
    const db = makeDb(rows, 3);

    try {
      const result = await listPublicCompetitions({}, db);

      expect(result.data.map((item) => item.id)).toEqual(["comp_1", "comp_2", "comp_3"]);
      expect(result.data.map((item) => item.institutionLogoUrl)).toEqual([null, null, null]);
      expect(generatePresignedGetUrl).not.toHaveBeenCalled();
    } finally {
      vi.mocked(isR2Available).mockReturnValue(true);
    }
  });

  it("selects both logo key columns in the listing query's projection", async () => {
    const db = makeDb([makeRow()], 1);

    await listPublicCompetitions({}, db);

    const projection = vi.mocked(db.select).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(projection).toHaveProperty("institutionLogoR2Key");
    expect(projection).toHaveProperty("institutionOwnerAvatarKey");
  });
});

describe("organiser logo address — search-index path", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns cards with their signed logo addresses", async () => {
    await useMeilisearchHits(["comp_1", "comp_2"]);
    const db = makeHydrationDb([
      makeRow({ id: "comp_1", institutionLogoR2Key: "logos/a.png" }),
      makeRow({ id: "comp_2" }),
    ]);

    const result = await listPublicCompetitions({ q: "lomba" }, db);

    expect(result.meta.searchEngine).toBe("meilisearch");
    expect(result.data[0]!.institutionLogoUrl).toBe(signedUrlFor("logos/a.png"));
    expect(result.data[1]!.institutionLogoUrl).toBeNull();
  });

  it("reads the logo keys in the one hydration query", async () => {
    await useMeilisearchHits(["comp_1", "comp_2", "comp_3"]);
    const db = makeHydrationDb([
      makeRow({ id: "comp_1", institutionLogoR2Key: "logos/a.png" }),
      makeRow({ id: "comp_2", institutionLogoR2Key: "logos/b.png" }),
      makeRow({ id: "comp_3", institutionLogoR2Key: "logos/c.png" }),
    ]);

    await listPublicCompetitions({ q: "lomba" }, db);

    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });
});

describe("organiser logo address — featured list", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns featured cards with their signed logo addresses, from one query", async () => {
    const db = makeFeaturedDb([
      makeRow({ id: "comp_1", isFeatured: true, institutionLogoR2Key: "logos/a.png" }),
      makeRow({ id: "comp_2", isFeatured: true, institutionLogoR2Key: "logos/b.png" }),
    ]);

    const result = await listFeaturedCompetitions(4, db);

    expect(result.map((item) => item.institutionLogoUrl)).toEqual([
      signedUrlFor("logos/a.png"),
      signedUrlFor("logos/b.png"),
    ]);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });
});
