// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/competitions/competition-participation-lock", () => ({
  acquireCompetitionParticipationLock: vi.fn(),
}));

import {
  ResultError,
  parseResultDraftInput,
  publishResult,
  unpublishResult,
  upsertResultDraft,
  getPublishedResultForCandidate,
} from "./result-service";

// ─── DB mock helpers ─────────────────────────────────────────────────────────

function createDbMock(opts: {
  selects?: unknown[][];
  updates?: unknown[][];
  inserts?: unknown[][];
  transactions?: unknown[];
}) {
  const selects = [...(opts.selects ?? [])];
  const updates = [...(opts.updates ?? [])];
  const inserts = [...(opts.inserts ?? [])];

  const selectChain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.innerJoin = () => c;
    c.leftJoin = () => c;
    c.where = () => c;
    c.limit = () => Promise.resolve(result);
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
  const insertChain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.values = () => c;
    c.onConflictDoUpdate = () => c;
    c.returning = () => Promise.resolve(result);
    return c;
  };

  const db: Record<string, unknown> = {
    select: () => selectChain(selects.shift() ?? []),
    update: () => updateChain(updates.shift() ?? []),
    insert: () => insertChain(inserts.shift() ?? []),
  };

  // transaction: call the fn with same db mock and return result
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);

  return db as never;
}

const catchResult = (fn: () => unknown): ResultError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ResultError) return e;
    throw e;
  }
  throw new Error("expected ResultError to be thrown");
};

const catchResultAsync = async (fn: () => Promise<unknown>): Promise<ResultError> => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ResultError) return e;
    throw e;
  }
  throw new Error("expected ResultError to be thrown");
};

// ─── parseResultDraftInput ────────────────────────────────────────────────────

describe("parseResultDraftInput", () => {
  afterEach(() => vi.clearAllMocks());

  it("accepts a label-only payload", () => {
    expect(parseResultDraftInput({ resultLabel: "Juara 1" })).toEqual({ resultLabel: "Juara 1" });
  });

  it("accepts a notes-only payload", () => {
    expect(parseResultDraftInput({ resultNotes: "Selamat" })).toEqual({ resultNotes: "Selamat" });
  });

  it("accepts both fields", () => {
    expect(parseResultDraftInput({ resultLabel: "Finalis", resultNotes: "ok" })).toEqual({
      resultLabel: "Finalis",
      resultNotes: "ok",
    });
  });

  it("accepts null for either field (clears them)", () => {
    expect(parseResultDraftInput({ resultLabel: null, resultNotes: null })).toEqual({
      resultLabel: null,
      resultNotes: null,
    });
  });

  it("accepts empty object (no-op update)", () => {
    expect(parseResultDraftInput({})).toEqual({});
  });

  it("rejects non-object body with 400", () => {
    expect(catchResult(() => parseResultDraftInput(null)).httpStatus).toBe(400);
    expect(catchResult(() => parseResultDraftInput("string")).code).toBe("result_invalid_payload");
  });

  it("rejects unknown keys with 400", () => {
    expect(catchResult(() => parseResultDraftInput({ foo: 1 })).httpStatus).toBe(400);
  });

  it("rejects non-string, non-null resultLabel with 400", () => {
    expect(catchResult(() => parseResultDraftInput({ resultLabel: 42 })).httpStatus).toBe(400);
  });
});

// ─── publishResult ─────────────────────────────────────────────────────────

describe("publishResult", () => {
  afterEach(() => vi.clearAllMocks());

  it("(a) happy path — publishes an individual result", async () => {
    const resultRow = {
      id: "res_1",
      registrationId: "reg_1",
      competitionId: "comp_1",
      resultStatus: "published",
      resultLabel: "Juara 1",
      resultNotes: null,
      publishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }], // ownsCompetition
        [{ registrationType: "individual", teamId: null, teamName: null }], // loadRegistrationMeta
        [{ resultLabel: "Juara 1" }], // existing label check
      ],
      updates: [[resultRow]], // publish update
    });

    const { result } = await publishResult("inst_1", "comp_1", "reg_1", "user_1", db);
    expect(result.resultStatus).toBe("published");
    expect(result.resultLabel).toBe("Juara 1");
  });

  it("refuses to publish a result for a cancelled competition", async () => {
    const db = createDbMock({
      selects: [[{ cancelledAt: new Date("2026-08-10T00:00:00.000Z") }]],
    });

    const error = await catchResultAsync(() =>
      publishResult("inst_1", "comp_1", "reg_1", "user_1", db),
    );

    expect(error.code).toBe("result_competition_cancelled");
    expect(error.httpStatus).toBe(409);
  });

  it("(b) rejects blank result_label with 422 before any DB write", async () => {
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }], // ownsCompetition
        [{ registrationType: "individual", teamId: null, teamName: null }], // loadRegistrationMeta
        [{ resultLabel: "   " }], // blank label
      ],
    });

    const err = await catchResultAsync(() =>
      publishResult("inst_1", "comp_1", "reg_1", "user_1", db),
    );
    expect(err.code).toBe("result_label_required");
    expect(err.httpStatus).toBe(422);
  });

  it("(c) rejects absent result row (no label) with 422", async () => {
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }],
        [{ registrationType: "individual", teamId: null, teamName: null }],
        [], // no existing row
      ],
    });

    const err = await catchResultAsync(() =>
      publishResult("inst_1", "comp_1", "reg_1", "user_1", db),
    );
    expect(err.code).toBe("result_label_required");
    expect(err.httpStatus).toBe(422);
  });

  it("(d) team upsert — creates result rows for all members and returns the requested row", async () => {
    const memberRow1 = {
      id: "res_1",
      registrationId: "reg_1",
      competitionId: "comp_1",
      resultStatus: "published",
      resultLabel: "Finalis",
      resultNotes: null,
      publishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const memberRow2 = { ...memberRow1, id: "res_2", registrationId: "reg_2" };
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }], // ownsCompetition
        [{ registrationType: "team", teamId: "team_1", teamName: "Tim Alpha" }], // loadRegistrationMeta
        [{ resultLabel: "Finalis", resultNotes: null }], // label check (inside tx)
        [{ id: "reg_1" }, { id: "reg_2" }], // member reg IDs (inside tx)
      ],
      inserts: [[memberRow1, memberRow2]], // upsert returns all member rows
    });

    const { result, teamId } = await publishResult("inst_1", "comp_1", "reg_1", "user_1", db);
    expect(result.resultStatus).toBe("published");
    expect(teamId).toBe("team_1");
  });

  it("(e) cross-institution registration → 404", async () => {
    const db = createDbMock({ selects: [[]] }); // ownsCompetition returns empty

    const err = await catchResultAsync(() =>
      publishResult("inst_X", "comp_1", "reg_1", "user_1", db),
    );
    expect(err.code).toBe("result_registration_not_found");
    expect(err.httpStatus).toBe(404);
  });

  it("(f) team publish — insert.values() covers ALL member reg IDs including members with no prior draft row", async () => {
    // This test guards the core fix: only reg_captain has a draft result row;
    // reg_member_2 has no result row yet. publishResult must include BOTH in
    // the INSERT … ON CONFLICT DO UPDATE so the non-captain gets a row created.
    let capturedValues: Array<{
      registrationId: string;
      resultStatus: string;
      resultLabel: string | null;
    }> = [];

    let selectCall = 0;
    const selectResults: Record<number, unknown[]> = {
      1: [{ id: "comp_1" }],
      2: [{ registrationType: "team", teamId: "team_1", teamName: "Tim Alpha" }],
      3: [{ resultLabel: "Juara 1", resultNotes: null }],
      4: [{ id: "reg_captain" }, { id: "reg_member_2" }], // reg_member_2 has no existing draft row
    };

    const db: Record<string, unknown> = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      select: () => {
        selectCall++;
        const result = selectResults[selectCall] ?? [];
        const c: Record<string, unknown> = {
          from: () => c,
          innerJoin: () => c,
          leftJoin: () => c,
          where: () => c,
          limit: () => Promise.resolve(result),
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject),
        };
        return c;
      },
      insert: () => {
        const c: Record<string, unknown> = {
          // Capture array args (result rows); skip object args (audit log insert).
          values: (vals: unknown) => {
            if (Array.isArray(vals)) capturedValues = vals as typeof capturedValues;
            return c;
          },
          onConflictDoUpdate: () => c,
          returning: () =>
            Promise.resolve(
              capturedValues.length > 0
                ? [
                    {
                      id: "r1",
                      registrationId: "reg_captain",
                      competitionId: "comp_1",
                      resultStatus: "published",
                      resultLabel: "Juara 1",
                      resultNotes: null,
                      publishedAt: new Date(),
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    },
                    {
                      id: "r2",
                      registrationId: "reg_member_2",
                      competitionId: "comp_1",
                      resultStatus: "published",
                      resultLabel: "Juara 1",
                      resultNotes: null,
                      publishedAt: new Date(),
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    },
                  ]
                : [],
            ),
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve([]).then(resolve, reject),
        };
        return c;
      },
    };

    await publishResult("inst_1", "comp_1", "reg_captain", "user_1", db as never);

    const regIds = capturedValues.map((v) => v.registrationId);
    expect(regIds).toContain("reg_captain");
    expect(regIds).toContain("reg_member_2"); // member with no prior draft row must be included
    expect(regIds).toHaveLength(2);
    capturedValues.forEach((v) => {
      expect(v.resultStatus).toBe("published");
      expect(v.resultLabel).toBe("Juara 1");
    });
  });

  it("(g) audit write — insert is called inside the transaction with result_published action", async () => {
    let capturedAuditValues: unknown = null;
    let insertCallCount = 0;

    const selectResults: unknown[][] = [
      [{ id: "comp_1" }],
      [{ registrationType: "individual", teamId: null, teamName: null }],
      [{ resultLabel: "Juara 1", resultNotes: null }],
    ];
    const db: Record<string, unknown> = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      select: () => {
        const result = selectResults.shift() ?? [];
        const c: Record<string, unknown> = {
          from: () => c,
          innerJoin: () => c,
          leftJoin: () => c,
          where: () => c,
          limit: () => Promise.resolve(result),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
        };
        return c;
      },
      update: () => {
        const resultRow = {
          id: "res_1",
          registrationId: "reg_1",
          competitionId: "comp_1",
          resultStatus: "published",
          resultLabel: "Juara 1",
          resultNotes: null,
          publishedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const c: Record<string, unknown> = {
          set: () => c,
          where: () => c,
          returning: () => Promise.resolve([resultRow]),
        };
        return c;
      },
      insert: () => {
        insertCallCount++;
        const c: Record<string, unknown> = {
          // Individual publish uses UPDATE for the result row; the INSERT is the audit log.
          values: (vals: unknown) => {
            if (insertCallCount === 1) capturedAuditValues = vals;
            return c;
          },
          onConflictDoUpdate: () => c,
          returning: () => Promise.resolve([]),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
        };
        return c;
      },
    };

    await publishResult("inst_1", "comp_1", "reg_1", "mem_1", db as never);

    expect(capturedAuditValues).not.toBeNull();
    const vals = capturedAuditValues as Record<string, unknown>;
    expect(vals.action).toBe("result_published");
    expect(vals.targetMembershipId).toBe("mem_1");
    expect(vals.institutionId).toBe("inst_1");
    const metadata = vals.metadata as Record<string, unknown>;
    expect(metadata.resultLabel).toBe("Juara 1");
  });
});

// ─── unpublishResult ──────────────────────────────────────────────────────────

describe("unpublishResult", () => {
  afterEach(() => vi.clearAllMocks());

  it("transitions published → draft and nulls published_at", async () => {
    const draftRow = {
      id: "res_1",
      registrationId: "reg_1",
      competitionId: "comp_1",
      resultStatus: "draft",
      resultLabel: "Juara 1",
      resultNotes: null,
      publishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }],
        [{ registrationType: "individual", teamId: null, teamName: null }],
      ],
      updates: [[draftRow]],
    });

    const result = await unpublishResult("inst_1", "comp_1", "reg_1", "user_1", db);
    expect(result.resultStatus).toBe("draft");
    expect(result.publishedAt).toBeNull();
  });

  it("cross-institution registration → 404", async () => {
    const db = createDbMock({ selects: [[]] });

    const err = await catchResultAsync(() =>
      unpublishResult("inst_X", "comp_1", "reg_1", "user_1", db),
    );
    expect(err.code).toBe("result_registration_not_found");
    expect(err.httpStatus).toBe(404);
  });
});

// ─── upsertResultDraft ────────────────────────────────────────────────────────

describe("upsertResultDraft", () => {
  afterEach(() => vi.clearAllMocks());

  it("refuses to create or edit a result draft for a cancelled competition", async () => {
    const db = createDbMock({
      selects: [[{ cancelledAt: new Date("2026-08-10T00:00:00.000Z") }]],
    });

    const error = await catchResultAsync(() =>
      upsertResultDraft("inst_1", "comp_1", "reg_1", { resultLabel: "Juara 1" }, db),
    );

    expect(error.code).toBe("result_competition_cancelled");
    expect(error.httpStatus).toBe(409);
  });

  it("creates or updates a draft result", async () => {
    const draftRow = {
      id: "res_1",
      registrationId: "reg_1",
      competitionId: "comp_1",
      resultStatus: "draft",
      resultLabel: "Juara 2",
      resultNotes: null,
      publishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }],
        [{ registrationType: "individual", teamId: null, teamName: null }],
        [], // no existing row (fresh insert)
      ],
      inserts: [[draftRow]],
    });

    const result = await upsertResultDraft(
      "inst_1",
      "comp_1",
      "reg_1",
      { resultLabel: "Juara 2" },
      db,
    );
    expect(result.resultStatus).toBe("draft");
    expect(result.resultLabel).toBe("Juara 2");
  });

  it("rejects upsert when result is already published (result_already_published 409)", async () => {
    const db = createDbMock({
      selects: [
        [{ id: "comp_1" }],
        [{ registrationType: "individual", teamId: null, teamName: null }],
        [{ resultStatus: "published" }], // existing published row
      ],
    });

    const err = await catchResultAsync(() =>
      upsertResultDraft("inst_1", "comp_1", "reg_1", { resultLabel: "New" }, db),
    );
    expect(err.code).toBe("result_already_published");
    expect(err.httpStatus).toBe(409);
  });

  it("cross-institution registration → 404", async () => {
    const db = createDbMock({ selects: [[]] });

    const err = await catchResultAsync(() =>
      upsertResultDraft("inst_X", "comp_1", "reg_1", { resultLabel: "x" }, db),
    );
    expect(err.code).toBe("result_registration_not_found");
    expect(err.httpStatus).toBe(404);
  });
});

// ─── getPublishedResultForCandidate ───────────────────────────────────────────

describe("getPublishedResultForCandidate", () => {
  afterEach(() => vi.clearAllMocks());

  it("(a) returns null when the registration does not exist", async () => {
    const db = createDbMock({ selects: [[]] }); // registration lookup returns empty
    const result = await getPublishedResultForCandidate("cand_1", "comp_1", "reg_X", db);
    expect(result).toBeNull();
  });

  it("(b) returns null when the registration belongs to a different candidate (IDOR)", async () => {
    const db = createDbMock({
      selects: [[{ studentId: "cand_2" }]], // wrong owner
    });
    const result = await getPublishedResultForCandidate("cand_1", "comp_1", "reg_1", db);
    expect(result).toBeNull();
  });

  it("(c) returns null when the result row is absent (draft filtered by WHERE)", async () => {
    const db = createDbMock({
      selects: [[{ studentId: "cand_1" }], []], // reg found, no published result row
    });
    const result = await getPublishedResultForCandidate("cand_1", "comp_1", "reg_1", db);
    expect(result).toBeNull();
  });

  it("(d) returns null when the result is unpublished (WHERE filters it out — empty array)", async () => {
    const db = createDbMock({
      selects: [
        [{ studentId: "cand_1" }],
        [], // WHERE result_status='published' returns empty for drafts
      ],
    });
    const result = await getPublishedResultForCandidate("cand_1", "comp_1", "reg_1", db);
    expect(result).toBeNull();
  });

  it("(e) returns resultLabel and resultNotes when published", async () => {
    const db = createDbMock({
      selects: [[{ studentId: "cand_1" }], [{ resultLabel: "Finalis", resultNotes: "Selamat!" }]],
    });
    const result = await getPublishedResultForCandidate("cand_1", "comp_1", "reg_1", db);
    expect(result).toEqual({ resultLabel: "Finalis", resultNotes: "Selamat!" });
  });

  it("(f) does not expose result_status or published_at in the return value", async () => {
    const db = createDbMock({
      selects: [[{ studentId: "cand_1" }], [{ resultLabel: "Winner", resultNotes: null }]],
    });
    const result = await getPublishedResultForCandidate("cand_1", "comp_1", "reg_1", db);
    expect(result).not.toBeNull();
    const keys = Object.keys(result ?? {});
    expect(keys).not.toContain("resultStatus");
    expect(keys).not.toContain("publishedAt");
  });
});
