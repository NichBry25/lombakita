// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const { enqueueCompetitionSearchSync } = vi.hoisted(() => ({
  enqueueCompetitionSearchSync: vi.fn(),
}));
vi.mock("@/server/async/enqueue", () => ({ enqueueCompetitionSearchSync }));

import {
  setFeaturedPlacement,
  FeaturedPlacementError,
} from "./featured-placement-service";
import type { Database } from "@/server/db/client";

const makeSelectDb = (row: { id: string; status: string } | null) => {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(row ? [row] : []),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(chain),
      update: vi.fn().mockReturnValue(updateChain),
    } as unknown as Database,
    updateChain,
  };
};

beforeEach(() => {
  enqueueCompetitionSearchSync.mockResolvedValue({});
});

describe("setFeaturedPlacement", () => {
  it("throws competition_not_found (404) when competition does not exist", async () => {
    const { db } = makeSelectDb(null);
    await expect(
      setFeaturedPlacement("comp_missing", { isFeatured: true, featuredOrder: 1 }, db),
    ).rejects.toThrow(FeaturedPlacementError);

    try {
      await setFeaturedPlacement("comp_missing", { isFeatured: true, featuredOrder: 1 }, db);
    } catch (e) {
      expect((e as FeaturedPlacementError).code).toBe("competition_not_found");
      expect((e as FeaturedPlacementError).status).toBe(404);
    }
  });

  it("throws competition_not_published (409) for draft competition", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "draft" });
    await expect(
      setFeaturedPlacement("comp_1", { isFeatured: true, featuredOrder: 1 }, db),
    ).rejects.toThrow(FeaturedPlacementError);

    try {
      await setFeaturedPlacement("comp_1", { isFeatured: true, featuredOrder: 1 }, db);
    } catch (e) {
      expect((e as FeaturedPlacementError).code).toBe("competition_not_published");
      expect((e as FeaturedPlacementError).status).toBe(409);
    }
  });

  it("throws competition_not_published (409) for archived competition", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "archived" });
    await expect(
      setFeaturedPlacement("comp_1", { isFeatured: true, featuredOrder: 1 }, db),
    ).rejects.toThrow(FeaturedPlacementError);

    try {
      await setFeaturedPlacement("comp_1", { isFeatured: true, featuredOrder: 1 }, db);
    } catch (e) {
      expect((e as FeaturedPlacementError).code).toBe("competition_not_published");
    }
  });

  it("succeeds for published competition and returns isFeatured + featuredOrder", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "published" });
    const result = await setFeaturedPlacement(
      "comp_1",
      { isFeatured: true, featuredOrder: 3 },
      db,
    );
    expect(result).toEqual({ isFeatured: true, featuredOrder: 3 });
  });

  it("clears featuredOrder when isFeatured=false regardless of passed value", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "published" });
    const result = await setFeaturedPlacement(
      "comp_1",
      { isFeatured: false, featuredOrder: 5 },
      db,
    );
    expect(result).toEqual({ isFeatured: false, featuredOrder: null });
  });

  it("accepts null featuredOrder when isFeatured=true", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "published" });
    const result = await setFeaturedPlacement(
      "comp_1",
      { isFeatured: true, featuredOrder: null },
      db,
    );
    expect(result).toEqual({ isFeatured: true, featuredOrder: null });
  });

  it("enqueues competition.search.sync after successful DB write", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "published" });
    await setFeaturedPlacement("comp_1", { isFeatured: true, featuredOrder: 1 }, db);
    expect(enqueueCompetitionSearchSync).toHaveBeenCalledWith({
      competitionId: "comp_1",
      action: "upsert",
    });
  });

  it("does not throw when enqueue fails — DB write still succeeds", async () => {
    enqueueCompetitionSearchSync.mockRejectedValueOnce(new Error("redis down"));
    const { db } = makeSelectDb({ id: "comp_1", status: "published" });
    const result = await setFeaturedPlacement(
      "comp_1",
      { isFeatured: true, featuredOrder: 2 },
      db,
    );
    expect(result).toEqual({ isFeatured: true, featuredOrder: 2 });
  });
});
