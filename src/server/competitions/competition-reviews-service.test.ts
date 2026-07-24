// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import { upsertMyReview } from "@/server/competitions/competition-reviews-service";

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
