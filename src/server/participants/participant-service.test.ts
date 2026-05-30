// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({ mockGetDb: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { listCompetitionParticipants } from "./participant-service";

// Counter-based db mock. db.select() is called synchronously in creation order, so each call
// captures its resultIndex at the time of the call rather than at microtask resolution time.
// Query creation order in listCompetitionParticipants:
//   0 — ownership check (sequential, before Promise.all)
//   1 — page data query (first in inner async IIFE, first in inner Promise.all)
//   2 — page count query (second in inner async IIFE, second in inner Promise.all)
//   3 — aggregate counts query (second arg of outer Promise.all, after IIFE starts)
//   4 — batch team member count (only when page contains team rows)
function createDbMock(results: unknown[][]) {
  let callIndex = 0;
  const makeChain = (resultIndex: number) => {
    const chain: Record<string, unknown> = {};
    for (const m of [
      "from",
      "leftJoin",
      "innerJoin",
      "where",
      "limit",
      "offset",
      "orderBy",
      "groupBy",
    ]) {
      chain[m] = vi.fn(() => chain);
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(results[resultIndex] ?? []).then(resolve, reject);
    return chain;
  };
  const db = { select: vi.fn(() => makeChain(callIndex++)) };
  return { db: db as never };
}

const individualRow = {
  registrationId: "reg_1",
  registrationType: "individual",
  status: "confirmed",
  registeredAt: new Date("2026-05-01T00:00:00.000Z"),
  teamId: null,
  candidateUserId: "user_1",
  candidateDisplayName: "Andi Pratama",
  candidateUsername: "andi",
  teamName: null,
  captainDisplayName: null,
  submissionRegistrationId: null,
  submissionFinalizedAt: null,
  submissionSubmittedAt: null,
};

const teamRow = {
  registrationId: "reg_2",
  registrationType: "team",
  status: "confirmed",
  registeredAt: new Date("2026-05-02T00:00:00.000Z"),
  teamId: "team_1",
  candidateUserId: "cap_1",
  candidateDisplayName: null,
  candidateUsername: "captain_andi",
  teamName: "Alpha Team",
  captainDisplayName: "Budi Santoso",
  submissionRegistrationId: null,
  submissionFinalizedAt: null,
  submissionSubmittedAt: null,
};

const oneConfirmedAgg = {
  total: 1,
  confirmed: 1,
  pending: 0,
  cancelled: 0,
  withSubmissions: 0,
  withFinalizedSubmissions: 0,
};

const fiveItemsAgg = {
  total: 5,
  confirmed: 3,
  pending: 1,
  cancelled: 1,
  withSubmissions: 2,
  withFinalizedSubmissions: 1,
};

const defaultFilters = { status: "all" as const, type: "all" as const, page: 1, limit: 20 };

describe("listCompetitionParticipants", () => {
  afterEach(() => vi.clearAllMocks());

  it("(a) returns correct individual participant row with correct shape", async () => {
    const { db } = createDbMock([
      [{ id: "comp_1" }],
      [individualRow],
      [{ count: 1 }],
      [oneConfirmedAgg],
    ]);
    const result = await listCompetitionParticipants("inst_1", "comp_1", defaultFilters, db);
    expect(result.participants).toHaveLength(1);
    const p = result.participants[0]!;
    expect(p.registrationType).toBe("individual");
    expect(p.candidate).not.toBeNull();
    expect(p.candidate?.displayName).toBe("Andi Pratama");
    expect(p.candidate?.username).toBe("andi");
    expect(p.team).toBeNull();
    expect(p.submission).toBeNull();
    expect(p.status).toBe("confirmed");
  });

  it("(b) returns correct team participant row with correct shape", async () => {
    const { db } = createDbMock([
      [{ id: "comp_1" }],
      [teamRow],
      [{ count: 1 }],
      [oneConfirmedAgg],
      [{ teamId: "team_1", count: 3 }],
    ]);
    const result = await listCompetitionParticipants("inst_1", "comp_1", defaultFilters, db);
    expect(result.participants).toHaveLength(1);
    const p = result.participants[0]!;
    expect(p.registrationType).toBe("team");
    expect(p.team).not.toBeNull();
    expect(p.team?.teamName).toBe("Alpha Team");
    expect(p.team?.captainDisplayName).toBe("Budi Santoso");
    expect(p.team?.activeMemberCount).toBe(3);
    expect(p.candidate).toBeNull();
  });

  it("(c) team rows include activeMemberCount from batched team_members query", async () => {
    const { db } = createDbMock([
      [{ id: "comp_1" }],
      [teamRow],
      [{ count: 1 }],
      [oneConfirmedAgg],
      [{ teamId: "team_1", count: 5 }],
    ]);
    const result = await listCompetitionParticipants("inst_1", "comp_1", defaultFilters, db);
    expect(result.participants[0]!.team?.activeMemberCount).toBe(5);
  });

  it("(d) cross-institution competitionId returns empty result with zero counts", async () => {
    const { db } = createDbMock([[]]);
    const result = await listCompetitionParticipants("inst_1", "comp_other", defaultFilters, db);
    expect(result.participants).toHaveLength(0);
    expect(result.counts.total).toBe(0);
    expect(result.counts.confirmed).toBe(0);
    expect(result.pagination.totalCount).toBe(0);
  });

  it("(e) filter by status=confirmed passes filter through to query", async () => {
    const confirmedRow = { ...individualRow, status: "confirmed" };
    const { db } = createDbMock([
      [{ id: "comp_1" }],
      [confirmedRow],
      [{ count: 1 }],
      [oneConfirmedAgg],
    ]);
    const result = await listCompetitionParticipants(
      "inst_1",
      "comp_1",
      { status: "confirmed", type: "all", page: 1, limit: 20 },
      db,
    );
    expect(result.participants[0]!.status).toBe("confirmed");
  });

  it("(f) filter by type=team passes filter through to query", async () => {
    const { db } = createDbMock([
      [{ id: "comp_1" }],
      [teamRow],
      [{ count: 1 }],
      [oneConfirmedAgg],
      [{ teamId: "team_1", count: 2 }],
    ]);
    const result = await listCompetitionParticipants(
      "inst_1",
      "comp_1",
      { status: "all", type: "team", page: 1, limit: 20 },
      db,
    );
    expect(result.participants[0]!.registrationType).toBe("team");
  });

  it("(g) aggregate counts reflect full competition regardless of active filter", async () => {
    const confirmedRow = { ...individualRow, status: "confirmed" };
    const { db } = createDbMock([
      [{ id: "comp_1" }],
      [confirmedRow],
      [{ count: 1 }],
      [fiveItemsAgg],
    ]);
    const result = await listCompetitionParticipants(
      "inst_1",
      "comp_1",
      { status: "confirmed" },
      db,
    );
    expect(result.counts.total).toBe(5);
    expect(result.counts.pending).toBe(1);
    expect(result.counts.cancelled).toBe(1);
    expect(result.counts.withSubmissions).toBe(2);
  });

  it("(h) submission present and finalized is reflected correctly", async () => {
    const submittedRow = {
      ...individualRow,
      submissionRegistrationId: "reg_1",
      submissionFinalizedAt: new Date("2026-06-01T00:00:00.000Z"),
      submissionSubmittedAt: new Date("2026-05-30T00:00:00.000Z"),
    };
    const { db } = createDbMock([
      [{ id: "comp_1" }],
      [submittedRow],
      [{ count: 1 }],
      [oneConfirmedAgg],
    ]);
    const result = await listCompetitionParticipants("inst_1", "comp_1", defaultFilters, db);
    const sub = result.participants[0]!.submission;
    expect(sub).not.toBeNull();
    expect(sub?.exists).toBe(true);
    expect(sub?.finalized).toBe(true);
    expect(sub?.finalizedAt).toBeTruthy();
    expect(sub?.submittedAt).toBeTruthy();
  });

  it("(i) no submission returns submission null", async () => {
    const { db } = createDbMock([
      [{ id: "comp_1" }],
      [individualRow],
      [{ count: 1 }],
      [oneConfirmedAgg],
    ]);
    const result = await listCompetitionParticipants("inst_1", "comp_1", defaultFilters, db);
    expect(result.participants[0]!.submission).toBeNull();
  });
});
