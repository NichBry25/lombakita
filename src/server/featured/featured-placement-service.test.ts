// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

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
import { logger } from "@/lib/logger";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE } from "@/server/institution-verification/operator-institution-conflict";
import {
  CONFLICTED_RELATIONSHIP_CASES,
  NO_INSTITUTION_RELATIONSHIP_READS,
  invalidOperatorActorCases,
  makeSequencedSelect,
  operatorActorRow,
  type SelectRows,
} from "@/server/testing/operator-writer-stubs";

const OPS_ACTOR_ID = "ops_1";

// Everything runs in one transaction that serves its reads in call order: the acting account, the
// competition, then the four reads of the institution-relationship check.
const makeSelectDb = (
  row: { id: string; status: string; institutionType?: string | null } | null,
  extras: { actorRow?: SelectRows[number] | null; relationshipReads?: SelectRows[] } = {},
) => {
  const actorRow = extras.actorRow === undefined ? operatorActorRow(OPS_ACTOR_ID) : extras.actorRow;
  const competitionRows = row ? [{ institutionType: null, institutionId: "inst_1", ...row }] : [];
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  const insertChain = { values: vi.fn().mockResolvedValue(undefined) };
  const tx = {
    select: makeSequencedSelect([
      actorRow ? [actorRow] : [],
      competitionRows,
      ...(extras.relationshipReads ?? NO_INSTITUTION_RELATIONSHIP_READS),
    ]),
    update: vi.fn().mockReturnValue(updateChain),
    insert: vi.fn().mockReturnValue(insertChain),
  };
  return {
    db: {
      select: vi.fn(),
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
    } as unknown as Database,
    tx,
    updateChain,
    insertChain,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  enqueueCompetitionSearchSync.mockResolvedValue({});
});

describe("setFeaturedPlacement", () => {
  it("throws competition_not_found (404) when competition does not exist", async () => {
    const { db } = makeSelectDb(null);
    const error = await setFeaturedPlacement(
      OPS_ACTOR_ID,
      "comp_missing",
      { isFeatured: true, featuredOrder: 1 },
      db,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FeaturedPlacementError);
    expect(error).toMatchObject({ code: "competition_not_found", status: 404 });
  });

  it("throws competition_not_published (409) for draft competition", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "draft" });
    const error = await setFeaturedPlacement(
      OPS_ACTOR_ID,
      "comp_1",
      { isFeatured: true, featuredOrder: 1 },
      db,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FeaturedPlacementError);
    expect(error).toMatchObject({ code: "competition_not_published", status: 409 });
  });

  it("throws competition_not_published (409) for archived competition", async () => {
    const { db } = makeSelectDb({ id: "comp_1", status: "archived" });
    const error = await setFeaturedPlacement(
      OPS_ACTOR_ID,
      "comp_1",
      { isFeatured: true, featuredOrder: 1 },
      db,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FeaturedPlacementError);
    expect(error).toMatchObject({ code: "competition_not_published", status: 409 });
  });

  it("throws competition_personal_not_featurable (409) when owned by a personal institution", async () => {
    const { db } = makeSelectDb({
      id: "comp_1",
      status: "published",
      institutionType: "personal",
    });
    const error = await setFeaturedPlacement(
      OPS_ACTOR_ID,
      "comp_1",
      { isFeatured: true, featuredOrder: 1 },
      db,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FeaturedPlacementError);
    expect(error).toMatchObject({ code: "competition_personal_not_featurable", status: 409 });
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

  it.each(invalidOperatorActorCases(OPS_ACTOR_ID))(
    "refuses a $label actor before reading the competition, and writes nothing",
    async ({ row, code }) => {
      const { db, tx, insertChain } = makeSelectDb(
        { id: "comp_1", status: "published" },
        { actorRow: row },
      );
      const refusal = await setFeaturedPlacement(
        OPS_ACTOR_ID,
        "comp_1",
        { isFeatured: true, featuredOrder: 1 },
        db,
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({ code, status: 403 });
      expect(tx.update).not.toHaveBeenCalled();
      expect(insertChain.values).not.toHaveBeenCalled();
      expect(enqueueCompetitionSearchSync).not.toHaveBeenCalled();
    },
  );

  it.each(CONFLICTED_RELATIONSHIP_CASES)(
    "refuses an operator with a $arm relationship to the institution, and writes nothing",
    async ({ reads }) => {
      const { db, tx, insertChain } = makeSelectDb(
        { id: "comp_1", status: "published" },
        { relationshipReads: reads },
      );
      const refusal = await setFeaturedPlacement(
        OPS_ACTOR_ID,
        "comp_1",
        { isFeatured: true, featuredOrder: 1 },
        db,
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({
        code: "operator_actor_conflicted",
        status: 403,
        message: OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
      });
      expect(tx.update).not.toHaveBeenCalled();
      expect(insertChain.values).not.toHaveBeenCalled();
      expect(enqueueCompetitionSearchSync).not.toHaveBeenCalled();
    },
  );

  it("audits the database actor, not the claimed one", async () => {
    const { db, insertChain } = makeSelectDb(
      { id: "comp_1", status: "published" },
      { actorRow: operatorActorRow("database-actor") },
    );
    await setFeaturedPlacement(
      "claimed-actor",
      "comp_1",
      { isFeatured: true, featuredOrder: 1 },
      db,
    );
    expect(insertChain.values).toHaveBeenCalledTimes(1);
    expect(insertChain.values.mock.calls[0]![0]).toMatchObject({ actorUserId: "database-actor" });
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
    expect(logger.error).toHaveBeenCalledWith("featured-placement.enqueue_failed", {
      competitionId: "comp_1",
      error: "redis down",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
