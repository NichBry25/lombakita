// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  listCandidateIndividualRegistrations,
  listCandidateTeamRegistrations,
} from "./candidate-registration-service";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");

// Build a chainable db.select mock. Each select() call consumes the next entry from queue.
// Supports: .from().innerJoin().innerJoin().innerJoin().where().orderBy().limit() chains.
const buildChain = (result: unknown[]) => {
  const limit = vi.fn().mockResolvedValue(result);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const whereChain: Record<string, unknown> = {
    orderBy,
    limit,
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  };
  const where = vi.fn().mockReturnValue(whereChain);
  const chain: Record<string, unknown> = { where, innerJoin: vi.fn(), limit, orderBy };
  (chain.innerJoin as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  const from = vi.fn().mockReturnValue(chain);
  return { from };
};

const makeDb = (queue: unknown[][]) => {
  let idx = 0;
  const select = vi.fn(() => buildChain(queue[idx++] ?? []));
  return { select };
};

const individualRow = (overrides: Record<string, unknown> = {}) => ({
  id: "reg_1",
  competitionId: "comp_1",
  registrationStatus: "confirmed",
  registeredAt: NOW,
  cancelledAt: null,
  createdAt: NOW,
  competitionTitle: "Hackathon 2026",
  competitionSlug: "hackathon-2026",
  competitionMode: "individual",
  registrationEndAt: FUTURE,
  eventStartAt: FUTURE,
  eventEndAt: FUTURE,
  institutionSlug: "ui",
  ...overrides,
});

const teamRow = (overrides: Record<string, unknown> = {}) => ({
  ...individualRow(),
  teamId: "team_1",
  teamName: "Team Alpha",
  teamStatus: "submitted",
  captainId: "user_cap",
  ...overrides,
});

describe("listCandidateIndividualRegistrations", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a confirmed individual registration with the correct shape", async () => {
    const row = individualRow();
    const db = makeDb([[row]]);
    mockGetDb.mockReturnValue(db);

    const result = await listCandidateIndividualRegistrations("user_1", db as never);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "reg_1",
      competitionTitle: "Hackathon 2026",
      registrationStatus: "confirmed",
      institutionSlug: "ui",
    });
  });

  it("includes cancelled registrations in the result (full history)", async () => {
    const row = individualRow({ registrationStatus: "cancelled", cancelledAt: NOW });
    const db = makeDb([[row]]);
    mockGetDb.mockReturnValue(db);

    const result = await listCandidateIndividualRegistrations("user_1", db as never);

    expect(result).toHaveLength(1);
    expect(result[0]?.registrationStatus).toBe("cancelled");
    expect(result[0]?.cancelledAt).toEqual(NOW);
  });

  it("returns an empty array when the candidate has no individual registrations", async () => {
    const db = makeDb([[]]);
    mockGetDb.mockReturnValue(db);

    const result = await listCandidateIndividualRegistrations("user_1", db as never);

    expect(result).toEqual([]);
  });

  it("passes the correct join shape (all competition and institution fields present)", async () => {
    const row = individualRow();
    const db = makeDb([[row]]);
    mockGetDb.mockReturnValue(db);

    const [item] = await listCandidateIndividualRegistrations("user_1", db as never);

    expect(item).toHaveProperty("competitionSlug", "hackathon-2026");
    expect(item).toHaveProperty("competitionMode", "individual");
    expect(item).toHaveProperty("registrationEndAt", FUTURE);
    expect(item).toHaveProperty("eventStartAt", FUTURE);
  });
});

describe("listCandidateTeamRegistrations", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns isCaptain = true when captainId matches userId", async () => {
    const row = teamRow({ captainId: "user_cap" });
    const db = makeDb([[row]]);
    mockGetDb.mockReturnValue(db);

    const result = await listCandidateTeamRegistrations("user_cap", db as never);

    expect(result).toHaveLength(1);
    expect(result[0]?.isCaptain).toBe(true);
  });

  it("returns isCaptain = false for a non-captain member", async () => {
    const row = teamRow({ captainId: "user_cap" });
    const db = makeDb([[row]]);
    mockGetDb.mockReturnValue(db);

    const result = await listCandidateTeamRegistrations("user_member", db as never);

    expect(result).toHaveLength(1);
    expect(result[0]?.isCaptain).toBe(false);
  });

  it("includes team name and team status in the result shape", async () => {
    const row = teamRow({ teamName: "Team Alpha", teamStatus: "submitted" });
    const db = makeDb([[row]]);
    mockGetDb.mockReturnValue(db);

    const result = await listCandidateTeamRegistrations("user_cap", db as never);

    expect(result[0]).toMatchObject({
      teamName: "Team Alpha",
      teamStatus: "submitted",
      teamId: "team_1",
    });
  });

  it("includes cancelled team registrations in the result", async () => {
    const row = teamRow({ registrationStatus: "cancelled", cancelledAt: NOW });
    const db = makeDb([[row]]);
    mockGetDb.mockReturnValue(db);

    const result = await listCandidateTeamRegistrations("user_cap", db as never);

    expect(result[0]?.registrationStatus).toBe("cancelled");
  });

  it("returns an empty array when the candidate has no team registrations", async () => {
    const db = makeDb([[]]);
    mockGetDb.mockReturnValue(db);

    const result = await listCandidateTeamRegistrations("user_1", db as never);

    expect(result).toEqual([]);
  });
});
