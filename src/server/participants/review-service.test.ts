// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  ReviewError,
  parseReviewUpdatePayload,
  updateRegistrationReview,
  getRegistrationReview,
} from "./review-service";

// db mock: select() chains end in .limit() (resolves next selects entry); update() chains
// end in .returning() (resolves next updates entry). Queues consumed FIFO in call order.
function createDbMock(opts: { selects?: unknown[][]; updates?: unknown[][] }) {
  const selects = [...(opts.selects ?? [])];
  const updates = [...(opts.updates ?? [])];

  const selectChain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.leftJoin = () => c;
    c.where = () => c;
    c.limit = () => Promise.resolve(result);
    // Thenable so queries ending in .where() (e.g. member count) can be awaited directly.
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return c;
  };
  const updateChain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.set = () => c;
    c.where = () => c;
    c.returning = () => Promise.resolve(result);
    return c;
  };

  return {
    select: () => selectChain(selects.shift() ?? []),
    update: () => updateChain(updates.shift() ?? []),
  } as never;
}

const catchReview = (fn: () => unknown): ReviewError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReviewError) return e;
    throw e;
  }
  throw new Error("expected ReviewError to be thrown");
};

describe("parseReviewUpdatePayload", () => {
  it("accepts a valid status-only payload", () => {
    expect(parseReviewUpdatePayload({ internalReviewStatus: "shortlisted" })).toEqual({
      internalReviewStatus: "shortlisted",
    });
  });

  it("accepts a valid notes-only payload (string)", () => {
    expect(parseReviewUpdatePayload({ internalNotes: "ok" })).toEqual({ internalNotes: "ok" });
  });

  it("accepts internalNotes: null (clears notes)", () => {
    expect(parseReviewUpdatePayload({ internalNotes: null })).toEqual({ internalNotes: null });
  });

  it("accepts both fields together", () => {
    expect(
      parseReviewUpdatePayload({ internalReviewStatus: "under_review", internalNotes: "x" }),
    ).toEqual({ internalReviewStatus: "under_review", internalNotes: "x" });
  });

  it("rejects an empty object with 400", () => {
    expect(catchReview(() => parseReviewUpdatePayload({})).httpStatus).toBe(400);
  });

  it("rejects a non-object body with 400", () => {
    expect(catchReview(() => parseReviewUpdatePayload(null)).httpStatus).toBe(400);
    expect(catchReview(() => parseReviewUpdatePayload("nope")).code).toBe("review_invalid_payload");
  });

  it("rejects unknown keys with 400", () => {
    expect(catchReview(() => parseReviewUpdatePayload({ foo: 1 })).httpStatus).toBe(400);
  });

  it("rejects an invalid status value with 422", () => {
    const err = catchReview(() => parseReviewUpdatePayload({ internalReviewStatus: "bogus" }));
    expect(err.httpStatus).toBe(422);
    expect(err.code).toBe("review_invalid_status");
  });

  it("rejects a non-string, non-null note with 400", () => {
    expect(catchReview(() => parseReviewUpdatePayload({ internalNotes: 5 })).httpStatus).toBe(400);
  });
});

describe("updateRegistrationReview", () => {
  afterEach(() => vi.clearAllMocks());

  it("(a) applies a valid status update and returns the updated fields", async () => {
    const db = createDbMock({
      selects: [[{ id: "comp_1" }], [{ registrationType: "individual", teamId: null }]],
      updates: [[{ internalReviewStatus: "shortlisted", internalNotes: null }]],
    });
    const result = await updateRegistrationReview(
      "inst_1",
      "comp_1",
      "reg_1",
      { internalReviewStatus: "shortlisted" },
      db,
    );
    expect(result.internalReviewStatus).toBe("shortlisted");
  });

  it("(b) applies a valid notes update and returns the updated fields", async () => {
    const db = createDbMock({
      selects: [[{ id: "comp_1" }], [{ registrationType: "individual", teamId: null }]],
      updates: [[{ internalReviewStatus: "pending_review", internalNotes: "catatan" }]],
    });
    const result = await updateRegistrationReview(
      "inst_1",
      "comp_1",
      "reg_1",
      { internalNotes: "catatan" },
      db,
    );
    expect(result.internalNotes).toBe("catatan");
  });

  it("(c) supports a both-fields partial update", async () => {
    const db = createDbMock({
      selects: [[{ id: "comp_1" }], [{ registrationType: "individual", teamId: null }]],
      updates: [[{ internalReviewStatus: "rejected", internalNotes: "no" }]],
    });
    const result = await updateRegistrationReview(
      "inst_1",
      "comp_1",
      "reg_1",
      { internalReviewStatus: "rejected", internalNotes: "no" },
      db,
    );
    expect(result).toEqual({ internalReviewStatus: "rejected", internalNotes: "no" });
  });

  it("(d) cross-institution competition returns 404 with no info leak", async () => {
    const db = createDbMock({ selects: [[]] }); // ownership check finds nothing
    await expect(
      updateRegistrationReview(
        "inst_1",
        "comp_other",
        "reg_1",
        { internalReviewStatus: "rejected" },
        db,
      ),
    ).rejects.toMatchObject({ code: "review_registration_not_found", httpStatus: 404 });
  });

  it("(e) unknown registration id returns 404", async () => {
    const db = createDbMock({
      selects: [[{ id: "comp_1" }], []], // competition owned, but registration not found
      updates: [],
    });
    await expect(
      updateRegistrationReview(
        "inst_1",
        "comp_1",
        "reg_unknown",
        { internalReviewStatus: "rejected" },
        db,
      ),
    ).rejects.toMatchObject({ code: "review_registration_not_found", httpStatus: 404 });
  });

  it("(f) team registration update returns updated fields (all-or-nothing via team_id)", async () => {
    const db = createDbMock({
      selects: [[{ id: "comp_1" }], [{ registrationType: "team", teamId: "team_1" }]],
      updates: [[{ internalReviewStatus: "shortlisted", internalNotes: null }]],
    });
    const result = await updateRegistrationReview(
      "inst_1",
      "comp_1",
      "reg_captain",
      { internalReviewStatus: "shortlisted" },
      db,
    );
    expect(result.internalReviewStatus).toBe("shortlisted");
  });
});

describe("getRegistrationReview", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns full context for an individual registration", async () => {
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }],
        [{ internalReviewStatus: "under_review", internalNotes: "abc", registrationType: "individual", teamId: null, teamName: null }],
      ],
    });
    const result = await getRegistrationReview("inst_1", "comp_1", "reg_1", db);
    expect(result).toEqual({
      internalReviewStatus: "under_review",
      internalNotes: "abc",
      registrationType: "individual",
      teamName: null,
      activeMemberCount: null,
    });
  });

  it("returns full context for a team registration including active member count", async () => {
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }],
        [{ internalReviewStatus: "pending_review", internalNotes: null, registrationType: "team", teamId: "team_1", teamName: "Alpha Team" }],
        [{ count: 4 }],
      ],
    });
    const result = await getRegistrationReview("inst_1", "comp_1", "reg_2", db);
    expect(result).toEqual({
      internalReviewStatus: "pending_review",
      internalNotes: null,
      registrationType: "team",
      teamName: "Alpha Team",
      activeMemberCount: 4,
    });
  });

  it("returns null when the competition is not owned by the institution", async () => {
    const db = createDbMock({ selects: [[]] });
    expect(await getRegistrationReview("inst_1", "comp_other", "reg_1", db)).toBeNull();
  });

  it("returns null when the registration is not found in the competition", async () => {
    const db = createDbMock({ selects: [[{ id: "comp_1" }], []] });
    expect(await getRegistrationReview("inst_1", "comp_1", "reg_x", db)).toBeNull();
  });
});
