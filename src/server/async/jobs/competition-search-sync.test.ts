// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompetitionSearchSyncJob } from "@/server/async/jobs/competition-search-sync";

const { isMeilisearchAvailable, getMeilisearchClient, getDb } = vi.hoisted(() => ({
  isMeilisearchAvailable: vi.fn(),
  getMeilisearchClient: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@/server/search/availability", () => ({ isMeilisearchAvailable }));
vi.mock("@/server/search/client", () => ({ getMeilisearchClient }));
vi.mock("@/server/db/client", () => ({ getDb }));

import { processCompetitionSearchSyncJob } from "@/server/async/jobs/competition-search-sync";

const makeJob = (data: { competitionId: string; action: "upsert" | "remove" }): CompetitionSearchSyncJob =>
  ({ data } as unknown as CompetitionSearchSyncJob);

const publishedDbRow = {
  id: "comp_1",
  title: "Lomba X",
  slug: "lomba-x",
  category: "technology",
  mode: "individual",
  registrationEndAt: new Date("2026-12-01"),
  createdAt: new Date("2026-05-01"),
  institutionSlug: "lk-univ",
  institutionName: "Universitas LK",
};

// Returns a DB stub that yields the given row when selected.
const makeDb = (row: typeof publishedDbRow | null) => ({
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(row ? [row] : []),
        }),
      }),
    }),
  }),
});

describe("processCompetitionSearchSyncJob — Meilisearch unavailable", () => {
  afterEach(() => vi.clearAllMocks());

  it("exits cleanly without touching Meilisearch", async () => {
    isMeilisearchAvailable.mockReturnValue(false);
    await expect(
      processCompetitionSearchSyncJob(makeJob({ competitionId: "comp_1", action: "upsert" })),
    ).resolves.toBeUndefined();
    expect(getMeilisearchClient).not.toHaveBeenCalled();
  });
});

describe("processCompetitionSearchSyncJob — remove action", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls deleteDocument and resolves", async () => {
    isMeilisearchAvailable.mockReturnValue(true);
    const deleteDocument = vi.fn().mockResolvedValue(undefined);
    getMeilisearchClient.mockReturnValue({
      index: vi.fn().mockReturnValue({ deleteDocument, addDocuments: vi.fn() }),
    });

    await processCompetitionSearchSyncJob(makeJob({ competitionId: "comp_1", action: "remove" }));
    expect(deleteDocument).toHaveBeenCalledWith("comp_1");
  });
});

describe("processCompetitionSearchSyncJob — upsert action", () => {
  afterEach(() => vi.clearAllMocks());

  it("indexes the competition when it is still published", async () => {
    isMeilisearchAvailable.mockReturnValue(true);
    getDb.mockReturnValue(makeDb(publishedDbRow));
    const addDocuments = vi.fn().mockResolvedValue(undefined);
    getMeilisearchClient.mockReturnValue({
      index: vi.fn().mockReturnValue({ addDocuments, deleteDocument: vi.fn() }),
    });

    await processCompetitionSearchSyncJob(makeJob({ competitionId: "comp_1", action: "upsert" }));
    expect(addDocuments).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: "comp_1",
          title: "Lomba X",
          status: "published",
          institutionSlug: "lk-univ",
        }),
      ],
      { primaryKey: "id" },
    );
  });

  it("removes from index when competition is no longer published (defensive removal)", async () => {
    isMeilisearchAvailable.mockReturnValue(true);
    getDb.mockReturnValue(makeDb(null)); // no row → unpublished between enqueue and execution
    const deleteDocument = vi.fn().mockResolvedValue(undefined);
    const addDocuments = vi.fn();
    getMeilisearchClient.mockReturnValue({
      index: vi.fn().mockReturnValue({ deleteDocument, addDocuments }),
    });

    await processCompetitionSearchSyncJob(makeJob({ competitionId: "comp_1", action: "upsert" }));
    expect(deleteDocument).toHaveBeenCalledWith("comp_1");
    expect(addDocuments).not.toHaveBeenCalled();
  });

  it("re-throws error for BullMQ retry when Meilisearch fails", async () => {
    isMeilisearchAvailable.mockReturnValue(true);
    getDb.mockReturnValue(makeDb(publishedDbRow));
    getMeilisearchClient.mockReturnValue({
      index: vi.fn().mockReturnValue({
        addDocuments: vi.fn().mockRejectedValue(new Error("index error")),
        deleteDocument: vi.fn(),
      }),
    });

    await expect(
      processCompetitionSearchSyncJob(makeJob({ competitionId: "comp_1", action: "upsert" })),
    ).rejects.toThrow("index error");
  });
});
