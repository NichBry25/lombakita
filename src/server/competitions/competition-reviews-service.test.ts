// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import { setReviewStatus, upsertMyReview } from "@/server/competitions/competition-reviews-service";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";

// Minimal chainable stub: db.select().from().where().limit() resolves to the configured rows;
// db.insert().values().onConflictDoUpdate() resolves. select() serves the registration lookup
// first, then the getMyReview read.
const makeDb = (registrationRows: unknown[], reviewRows: unknown[]) => {
  let selectCall = 0;
  const insertSpy = vi.fn(() => ({
    values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
  }));
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectCall++ === 0 ? registrationRows : reviewRows),
        }),
      }),
    })),
    insert: insertSpy,
  } as unknown as Database;
  return { db, insertSpy };
};

describe("upsertMyReview participation gate", () => {
  it("rejects a caller with no confirmed registration and never writes", async () => {
    const { db, insertSpy } = makeDb([], []);
    await expect(upsertMyReview("user_1", "comp_1", { rating: 5 }, db)).rejects.toMatchObject({
      code: "review_not_eligible",
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("writes the review when the caller has a confirmed registration", async () => {
    const reviewRow = {
      id: "rev_1",
      rating: 5,
      body: "Bagus",
      status: "visible",
      createdAt: new Date("2026-07-23"),
    };
    const { db, insertSpy } = makeDb([{ id: "reg_1" }], [reviewRow]);
    const result = await upsertMyReview("user_1", "comp_1", { rating: 5, body: "Bagus" }, db);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(result.id).toBe("rev_1");
    expect(result.rating).toBe(5);
  });

  it("validates the payload before checking eligibility", async () => {
    const { db, insertSpy } = makeDb([{ id: "reg_1" }], []);
    await expect(upsertMyReview("user_1", "comp_1", { rating: 9 }, db)).rejects.toMatchObject({
      code: "review_invalid_value",
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

// The transaction serves the acting account first, then the review; the post-commit re-read goes
// through the pool handle. The order is part of what is asserted: a writer that reads the review
// before the actor reads the actor's row as the review.
const OPS_ACTOR = { id: "ops1", role: "platform_ops", suspendedAt: null };

const makeModerationDb = (
  actorRow: Record<string, unknown> | null,
  reviewRow: Record<string, unknown> | null,
) => {
  let txSelectCall = 0;
  const txReads = [actorRow ? [actorRow] : [], reviewRow ? [reviewRow] : []];
  const auditRows: Array<Record<string, unknown>> = [];
  const tx = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(txReads[txSelectCall++] ?? []) }),
      }),
    })),
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
    insert: vi.fn(() => ({
      values: (row: Record<string, unknown>) => {
        auditRows.push(row);
        return Promise.resolve(undefined);
      },
    })),
  };
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              { id: "rev_1", rating: 4, body: null, status: "hidden", createdAt: new Date() },
            ]),
        }),
      }),
    })),
    transaction: vi.fn(async (run: (t: unknown) => Promise<unknown>) => run(tx)),
  } as unknown as Database;
  return { db, tx, auditRows };
};

describe("setReviewStatus operator integrity", () => {
  it.each([
    { label: "missing", row: null, code: "operator_actor_not_found" },
    {
      label: "candidate",
      row: { id: "ops1", role: "candidate", suspendedAt: null },
      code: "operator_actor_not_platform_ops",
    },
    {
      label: "suspended operator",
      row: { id: "ops1", role: "platform_ops", suspendedAt: new Date() },
      code: "operator_actor_suspended",
    },
  ])("refuses a $label actor and writes nothing", async ({ row, code }) => {
    const { db, tx, auditRows } = makeModerationDb(row, { id: "rev_1", authorUserId: "author" });
    const refusal = await setReviewStatus("ops1", "rev_1", "hidden", "spam", db).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({ code, status: 403 });
    expect(tx.update).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it("refuses an actor moderating the review they wrote, and writes nothing", async () => {
    const { db, tx, auditRows } = makeModerationDb(OPS_ACTOR, {
      id: "rev_1",
      authorUserId: "ops1",
    });
    const refusal = await setReviewStatus("ops1", "rev_1", "hidden", "spam", db).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({
      code: "operator_actor_is_target",
      status: 403,
      message: "A platform-ops account cannot moderate its own review",
    });
    expect(tx.update).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it("404s a review that does not exist, and writes nothing", async () => {
    const { db, tx, auditRows } = makeModerationDb(OPS_ACTOR, null);
    await expect(setReviewStatus("ops1", "missing", "hidden", "spam", db)).rejects.toMatchObject({
      code: "review_not_found",
    });
    expect(tx.update).not.toHaveBeenCalled();
    expect(auditRows).toHaveLength(0);
  });

  it("validates an empty reason before any database read", async () => {
    const { db, tx } = makeModerationDb(OPS_ACTOR, { id: "rev_1", authorUserId: "author" });
    await expect(setReviewStatus("ops1", "rev_1", "hidden", "  ", db)).rejects.toMatchObject({
      code: "review_invalid_value",
    });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
  });

  it("writes exactly one audit row naming the database actor", async () => {
    const { db, auditRows } = makeModerationDb(
      { id: "database-actor", role: "platform_ops", suspendedAt: null },
      { id: "rev_1", authorUserId: "author" },
    );
    const result = await setReviewStatus("claimed-actor", "rev_1", "hidden", " spam ", db);
    expect(result.status).toBe("hidden");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorUserId: "database-actor",
      targetUserId: "author",
      eventType: "competition_review.hidden",
      reason: "spam",
      metadata: { reviewId: "rev_1" },
    });
  });
});
