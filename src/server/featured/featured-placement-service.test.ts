// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const { enqueueCompetitionSearchSync } = vi.hoisted(() => ({
  enqueueCompetitionSearchSync: vi.fn(),
}));
vi.mock("@/server/async/enqueue", () => ({ enqueueCompetitionSearchSync }));

import {
  FEATURED_CLEARED_EVENT,
  FEATURED_SET_EVENT,
  FeaturedPlacementError,
  setFeaturedPlacement,
} from "./featured-placement-service";
import type { Database } from "@/server/db/client";

const OPS_ACTOR_ID = "ops_1";

const makeSelectDb = (
  row: { id: string; status: string; institutionType?: string | null } | null,
) => {
  const chain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi
      .fn()
      .mockResolvedValue(row ? [{ institutionType: null, institutionId: "inst_1", ...row }] : []),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  const insertChain = { values: vi.fn().mockResolvedValue(undefined) };
  const tx = {
    update: vi.fn().mockReturnValue(updateChain),
    insert: vi.fn().mockReturnValue(insertChain),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(chain),
      update: tx.update,
      insert: tx.insert,
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
    } as unknown as Database,
    updateChain,
    insertChain,
  };
};

beforeEach(() => {
  enqueueCompetitionSearchSync.mockResolvedValue({});
});

describe("setFeaturedPlacement", () => {
  it("throws competition_not_found (404) when competition does not exist", async () => {
    const { db } = makeSelectDb(null);
    await expect(
      setFeaturedPlacement(
        OPS_ACTOR_ID,
        "comp_missing",
        { isFeatured: true, featuredOrder: 1 },
        db,
      ),
    ).rejects.toThrow(FeaturedPlacementError);

    try {
      await setFeaturedPlacement(
        OPS_ACTOR_ID,
        "comp_missing",
        { isFeatured: true, featuredOrder: 1 },
        db,
      );
    } catch (e) {
      expect((e as FeaturedPlacementError).code).toBe("competition_not_found");
      expect((e as FeaturedPlacementError).status).toBe(404);
    }
  });

  it("throws competition_not_published (409) for draft competition", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "draft" });
    await expect(
      setFeaturedPlacement(OPS_ACTOR_ID, "comp_1", { isFeatured: true, featuredOrder: 1 }, db),
    ).rejects.toThrow(FeaturedPlacementError);

    try {
      await setFeaturedPlacement(
        OPS_ACTOR_ID,
        "comp_1",
        { isFeatured: true, featuredOrder: 1 },
        db,
      );
    } catch (e) {
      expect((e as FeaturedPlacementError).code).toBe("competition_not_published");
      expect((e as FeaturedPlacementError).status).toBe(409);
    }
  });

  it("throws competition_not_published (409) for archived competition", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "archived" });
    await expect(
      setFeaturedPlacement(OPS_ACTOR_ID, "comp_1", { isFeatured: true, featuredOrder: 1 }, db),
    ).rejects.toThrow(FeaturedPlacementError);

    try {
      await setFeaturedPlacement(
        OPS_ACTOR_ID,
        "comp_1",
        { isFeatured: true, featuredOrder: 1 },
        db,
      );
    } catch (e) {
      expect((e as FeaturedPlacementError).code).toBe("competition_not_published");
    }
  });

  it("throws competition_personal_not_featurable (409) when owned by a personal institution", async () => {
    const { db } = makeSelectDb({
      id: "comp_1",
      status: "published",
      institutionType: "personal",
    });
    await expect(
      setFeaturedPlacement(OPS_ACTOR_ID, "comp_1", { isFeatured: true, featuredOrder: 1 }, db),
    ).rejects.toThrow(FeaturedPlacementError);

    try {
      await setFeaturedPlacement(
        OPS_ACTOR_ID,
        "comp_1",
        { isFeatured: true, featuredOrder: 1 },
        db,
      );
    } catch (e) {
      expect((e as FeaturedPlacementError).code).toBe("competition_personal_not_featurable");
      expect((e as FeaturedPlacementError).status).toBe(409);
    }
  });

  // Featured placement is the front-page slot and a monetized surface, so the audit trail — not a
  // server log line — has to answer who put a competition there and who took it off.
  it("audits a set against the owning institution, carrying the competition in metadata", async () => {
    const { db, insertChain } = makeSelectDb({ id: "comp_1", status: "published" });

    await setFeaturedPlacement(OPS_ACTOR_ID, "comp_1", { isFeatured: true, featuredOrder: 2 }, db);

    expect(insertChain.values).toHaveBeenCalledWith({
      actorUserId: OPS_ACTOR_ID,
      targetInstitutionId: "inst_1",
      eventType: FEATURED_SET_EVENT,
      metadata: { competitionId: "comp_1", featuredOrder: 2 },
    });
    // Placement change and audit row land together or not at all.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("audits an unset under a distinct event type with the order cleared", async () => {
    const { db, insertChain } = makeSelectDb({ id: "comp_1", status: "published" });

    await setFeaturedPlacement(OPS_ACTOR_ID, "comp_1", { isFeatured: false, featuredOrder: 5 }, db);

    expect(insertChain.values).toHaveBeenCalledWith({
      actorUserId: OPS_ACTOR_ID,
      targetInstitutionId: "inst_1",
      eventType: FEATURED_CLEARED_EVENT,
      metadata: { competitionId: "comp_1", featuredOrder: null },
    });
  });

  it("writes no audit row when the competition is rejected before the write", async () => {
    const { db, insertChain } = makeSelectDb({ id: "comp_1", status: "draft" });

    await expect(
      setFeaturedPlacement(OPS_ACTOR_ID, "comp_1", { isFeatured: true, featuredOrder: 1 }, db),
    ).rejects.toMatchObject({ code: "competition_not_published" });
    expect(insertChain.values).not.toHaveBeenCalled();
  });

  it("allows featuring a competition owned by a legacy (NULL-type) institution", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "published", institutionType: null });
    const result = await setFeaturedPlacement(
      OPS_ACTOR_ID,
      "comp_1",
      { isFeatured: true, featuredOrder: 1 },
      db,
    );
    expect(result).toEqual({ isFeatured: true, featuredOrder: 1 });
  });

  it("succeeds for published competition and returns isFeatured + featuredOrder", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "published" });
    const result = await setFeaturedPlacement(
      OPS_ACTOR_ID,
      "comp_1",
      { isFeatured: true, featuredOrder: 3 },
      db,
    );
    expect(result).toEqual({ isFeatured: true, featuredOrder: 3 });
  });

  it("clears featuredOrder when isFeatured=false regardless of passed value", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "published" });
    const result = await setFeaturedPlacement(
      OPS_ACTOR_ID,
      "comp_1",
      { isFeatured: false, featuredOrder: 5 },
      db,
    );
    expect(result).toEqual({ isFeatured: false, featuredOrder: null });
  });

  it("accepts null featuredOrder when isFeatured=true", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "published" });
    const result = await setFeaturedPlacement(
      OPS_ACTOR_ID,
      "comp_1",
      { isFeatured: true, featuredOrder: null },
      db,
    );
    expect(result).toEqual({ isFeatured: true, featuredOrder: null });
  });

  it("enqueues competition.search.sync after successful DB write", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "published" });
    await setFeaturedPlacement(OPS_ACTOR_ID, "comp_1", { isFeatured: true, featuredOrder: 1 }, db);
    expect(enqueueCompetitionSearchSync).toHaveBeenCalledWith({
      competitionId: "comp_1",
      action: "upsert",
    });
  });

  it("does not throw when enqueue fails — DB write still succeeds", async () => {
    enqueueCompetitionSearchSync.mockRejectedValueOnce(new Error("redis down"));
    const { db } = makeSelectDb({ id: "comp_1", status: "published" });
    const result = await setFeaturedPlacement(
      OPS_ACTOR_ID,
      "comp_1",
      { isFeatured: true, featuredOrder: 2 },
      db,
    );
    expect(result).toEqual({ isFeatured: true, featuredOrder: 2 });
  });
});
