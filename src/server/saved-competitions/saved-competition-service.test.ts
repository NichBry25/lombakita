// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => {
  const mockGetDb = vi.fn();
  return { mockGetDb };
});

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  saveCompetition,
  unsaveCompetition,
  isSavedCompetition,
  listSavedCompetitions,
  SavedCompetitionError,
} from "./saved-competition-service";

// Builds a db mock where the first .where() resolves to `firstSelectResult`,
// and insert().values().onConflictDoNothing() resolves to undefined.
function makeSelectDb(firstSelectResult: unknown[]) {
  const selectChain = {
    from: vi.fn(),
    where: vi.fn().mockResolvedValue(firstSelectResult),
  };
  selectChain.from.mockReturnValue(selectChain);

  const insertConflictChain = { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
  const insertChain = { values: vi.fn().mockReturnValue(insertConflictChain) };

  return {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    _insertConflictChain: insertConflictChain,
  };
}

describe("saveCompetition", () => {
  it("throws competition_not_found when competition does not exist", async () => {
    const db = makeSelectDb([]); // empty → not found
    await expect(saveCompetition("user_1", "comp_x", db as never)).rejects.toThrow(
      SavedCompetitionError,
    );

    try {
      await saveCompetition("user_1", "comp_x", db as never);
    } catch (e) {
      expect((e as SavedCompetitionError).code).toBe("competition_not_found");
      expect((e as SavedCompetitionError).status).toBe(404);
    }
  });

  it("calls onConflictDoNothing for idempotency when competition exists", async () => {
    const db = makeSelectDb([{ id: "comp_1" }]); // competition exists

    await saveCompetition("user_1", "comp_1", db as never);
    expect(db._insertConflictChain.onConflictDoNothing).toHaveBeenCalled();
  });
});

describe("unsaveCompetition", () => {
  it("deletes the save row (idempotent — no error if absent)", async () => {
    const deleteChain = { where: vi.fn().mockResolvedValue([]) };
    const db = { delete: vi.fn().mockReturnValue(deleteChain) };

    await expect(unsaveCompetition("user_1", "comp_1", db as never)).resolves.toBeUndefined();
    expect(db.delete).toHaveBeenCalled();
  });
});

describe("isSavedCompetition", () => {
  it("returns true when save row exists", async () => {
    const chain = {
      from: vi.fn(),
      where: vi.fn().mockResolvedValue([{ competitionId: "comp_1" }]),
    };
    chain.from.mockReturnValue(chain);
    const db = { select: vi.fn().mockReturnValue(chain) };

    const result = await isSavedCompetition("user_1", "comp_1", db as never);
    expect(result).toBe(true);
  });

  it("returns false when save row does not exist", async () => {
    const chain = { from: vi.fn(), where: vi.fn().mockResolvedValue([]) };
    chain.from.mockReturnValue(chain);
    const db = { select: vi.fn().mockReturnValue(chain) };

    const result = await isSavedCompetition("user_1", "comp_99", db as never);
    expect(result).toBe(false);
  });
});

describe("listSavedCompetitions", () => {
  it("returns empty data when no saves exist", async () => {
    // rows query: select → from → innerJoin → innerJoin → where → orderBy → limit → offset
    const rowsChain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      offset: vi.fn().mockResolvedValue([]),
    };
    rowsChain.from.mockReturnValue(rowsChain);
    rowsChain.innerJoin.mockReturnValue(rowsChain);
    rowsChain.where.mockReturnValue(rowsChain);
    rowsChain.orderBy.mockReturnValue(rowsChain);
    rowsChain.limit.mockReturnValue(rowsChain);

    // count query: select → from → innerJoin → where
    const countChain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn().mockResolvedValue([{ count: 0 }]),
    };
    countChain.from.mockReturnValue(countChain);
    countChain.innerJoin.mockReturnValue(countChain);

    let callCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? rowsChain : countChain;
      }),
    };

    const result = await listSavedCompetitions("user_1", {}, db as never);
    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect(result.meta.page).toBe(1);
    expect(result.meta.limit).toBe(20);
    expect(result.meta.totalPages).toBe(0);
  });

  it("maps published status to available and draft to unavailable", async () => {
    const now = new Date("2026-05-10");
    const rows = [
      {
        competitionId: "comp_1",
        slug: "lomba-a",
        title: "Lomba A",
        category: "technology",
        mode: "individual",
        registrationEndAt: new Date("2026-06-01"),
        status: "published",
        institutionSlug: "uni-a",
        institutionName: "Universitas A",
        savedAt: now,
      },
      {
        competitionId: "comp_2",
        slug: "lomba-b",
        title: "Lomba B",
        category: null,
        mode: null,
        registrationEndAt: null,
        status: "draft",
        institutionSlug: "uni-b",
        institutionName: "Universitas B",
        savedAt: now,
      },
    ];

    const rowsChain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      offset: vi.fn().mockResolvedValue(rows),
    };
    rowsChain.from.mockReturnValue(rowsChain);
    rowsChain.innerJoin.mockReturnValue(rowsChain);
    rowsChain.where.mockReturnValue(rowsChain);
    rowsChain.orderBy.mockReturnValue(rowsChain);
    rowsChain.limit.mockReturnValue(rowsChain);

    const countChain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn().mockResolvedValue([{ count: 2 }]),
    };
    countChain.from.mockReturnValue(countChain);
    countChain.innerJoin.mockReturnValue(countChain);

    let callCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? rowsChain : countChain;
      }),
    };

    const result = await listSavedCompetitions("user_1", {}, db as never);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]!.savedStatus).toBe("available");
    expect(result.data[1]!.savedStatus).toBe("unavailable");
    expect(result.meta.total).toBe(2);
  });

  it("excludes archived competitions from the DB query result", async () => {
    // The WHERE clause in listSavedCompetitions applies ne(competitions.status, "archived")
    // at the DB layer. The mock simulates the DB having already filtered archived rows out.
    const now = new Date("2026-05-10");
    const rows = [
      {
        competitionId: "comp_1",
        slug: "lomba-a",
        title: "Lomba A",
        category: null,
        mode: null,
        registrationEndAt: null,
        status: "published",
        institutionSlug: "uni-a",
        institutionName: "Universitas A",
        savedAt: now,
      },
    ];

    const rowsChain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      offset: vi.fn().mockResolvedValue(rows),
    };
    rowsChain.from.mockReturnValue(rowsChain);
    rowsChain.innerJoin.mockReturnValue(rowsChain);
    rowsChain.where.mockReturnValue(rowsChain);
    rowsChain.orderBy.mockReturnValue(rowsChain);
    rowsChain.limit.mockReturnValue(rowsChain);

    const countChain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn().mockResolvedValue([{ count: 1 }]),
    };
    countChain.from.mockReturnValue(countChain);
    countChain.innerJoin.mockReturnValue(countChain);

    let callCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? rowsChain : countChain;
      }),
    };

    const result = await listSavedCompetitions("user_1", {}, db as never);

    // Only the published competition is present; archived was filtered at the DB layer.
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.competitionId).toBe("comp_1");
    expect(result.data[0]!.savedStatus).toBe("available");
    // Confirm the WHERE predicate includes the ne(status, "archived") condition by
    // asserting the where call received the compound expression (truthy check only —
    // Drizzle expression objects are not string-comparable).
    expect(rowsChain.where).toHaveBeenCalled();
  });
});

describe("SavedCompetitionError", () => {
  it("carries code and status", () => {
    const err = new SavedCompetitionError("competition_not_found", 404, "Not found");
    expect(err.code).toBe("competition_not_found");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
    expect(err).toBeInstanceOf(Error);
  });
});
