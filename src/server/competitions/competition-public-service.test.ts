// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import type { PublicCompetitionItem } from "@/server/competitions/competition-public-service";

// Meilisearch is stubbed out for all DB-path tests.
vi.mock("@/server/search/availability", () => ({ isMeilisearchAvailable: vi.fn(() => false) }));
vi.mock("@/server/search/client", () => ({ getMeilisearchClient: vi.fn() }));

import {
  listPublicCompetitions,
  deriveCTAState,
} from "@/server/competitions/competition-public-service";

// Builds a chainable Drizzle mock where:
//   first db.select() → resolves rows after full chain .from().innerJoin().where().orderBy().limit().offset()
//   second db.select() → resolves count array after .from().innerJoin().where()
const makeDb = (rows: PublicCompetitionItem[], total: number): Database => {
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

const makeRow = (overrides: Partial<PublicCompetitionItem> = {}): PublicCompetitionItem => ({
  id: "comp_1",
  slug: "lomba-x",
  title: "Lomba X",
  description: "Deskripsi",
  category: "technology",
  mode: "individual",
  minTeamSize: null,
  maxTeamSize: null,
  registrationStartAt: null,
  registrationEndAt: null,
  eventStartAt: null,
  eventEndAt: null,
  publishedAt: new Date("2026-05-01"),
  createdAt: new Date("2026-05-01"),
  updatedAt: new Date("2026-05-01"),
  isFeatured: false,
  institutionSlug: "lk-univ",
  institutionName: "Universitas LK",
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
const makeHydrationDb = (rows: PublicCompetitionItem[]): Database =>
  ({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  }) as unknown as Database;

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
