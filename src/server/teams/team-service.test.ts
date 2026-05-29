// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/server/teams/team-email", () => ({ sendTeamInvitationEmail: vi.fn() }));

import {
  acceptTeamInvitation,
  createTeam,
  declineTeamInvitation,
  disbandTeam,
  inviteTeamMember,
  removeTeamMember,
} from "./team-service";
import { hashToken } from "./team-core";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const RAW_TOKEN = "a".repeat(64);
const TOKEN_HASH = hashToken(RAW_TOKEN);

type SelectResult = unknown[];

// Build a chainable select that returns the next pre-queued row set on .limit() or directly
// awaitable. Each select() call consumes one entry from `selectQueue`.
const makeDb = (
  selectQueue: SelectResult[],
  options: {
    insertReturning?: unknown[];
    updateReturning?: unknown[];
    insertError?: unknown;
    transactionSelectQueue?: SelectResult[];
    transactionInsertReturning?: unknown[];
    transactionInsertError?: unknown;
  } = {},
) => {
  const buildChain = (queue: SelectResult[]) => {
    const select = vi.fn(() => {
      const result = queue.shift() ?? [];
      const limit = vi.fn().mockResolvedValue(result);
      const orderBy = vi.fn().mockReturnValue({ limit });
      const innerJoinB = vi.fn().mockReturnThis();
      const leftJoinB = vi.fn().mockReturnThis();
      const whereChain: {
        limit: ReturnType<typeof vi.fn>;
        orderBy: ReturnType<typeof vi.fn>;
        then: (cb: (value: unknown) => unknown) => Promise<unknown>;
      } = {
        limit,
        orderBy,
        // Allow awaiting the chain (e.g. for unbounded selects) — resolves to the queued result.
        then: (cb) => Promise.resolve(result).then(cb),
      };
      const where = vi.fn().mockReturnValue(whereChain);
      const innerJoin = vi.fn();
      const leftJoin = vi.fn();
      const fromChain = { where, innerJoin, leftJoin, limit, orderBy };
      innerJoin.mockReturnValue(fromChain);
      leftJoin.mockReturnValue(fromChain);
      innerJoinB.mockReturnValue(fromChain);
      leftJoinB.mockReturnValue(fromChain);
      const from = vi.fn().mockReturnValue(fromChain);
      return { from };
    });
    return select;
  };

  const select = buildChain(selectQueue);

  const insertReturning = vi.fn().mockResolvedValue(options.insertReturning ?? []);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const insertWithError = () => {
    if (options.insertError) {
      return {
        values: vi.fn().mockImplementation(() => {
          // .values() can be either awaited directly or have .returning() called.
          const p = {
            returning: vi.fn().mockRejectedValue(options.insertError),
            then: (cb: (value: unknown) => unknown) =>
              Promise.reject(options.insertError).then(undefined, cb),
          };
          return p;
        }),
      };
    }
    return { values: insertValues };
  };
  const insert = vi.fn(insertWithError);

  const updateReturning = vi.fn().mockResolvedValue(options.updateReturning ?? []);
  const updateWhere = vi.fn().mockResolvedValue(options.updateReturning ?? []);
  Object.assign(updateWhere, { returning: updateReturning });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere, returning: updateReturning });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  // Transaction-scoped tx mock.
  const txSelectQueue = options.transactionSelectQueue ?? [];
  const txInsertReturning = options.transactionInsertReturning ?? [];
  const txInsertError = options.transactionInsertError;

  const tx = {
    select: buildChain(txSelectQueue),
    insert: vi.fn(() => {
      if (txInsertError) {
        return {
          values: vi.fn().mockImplementation(() => {
            return Promise.reject(txInsertError);
          }),
        };
      }
      return {
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(txInsertReturning),
        }),
      };
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  };

  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb(tx);
  });

  return { db: { select, insert, update, transaction }, tx };
};

const baseCompetition = (overrides: Record<string, unknown> = {}) => ({
  id: "comp_1",
  title: "Hackathon 2026",
  status: "published" as const,
  mode: "team" as const,
  maxTeamSize: 4,
  registrationEndAt: FUTURE,
  ...overrides,
});

const baseTeam = (overrides: Record<string, unknown> = {}) => ({
  id: "team_1",
  competitionId: "comp_1",
  name: "Tim Alfa",
  captainId: "cand_captain",
  status: "forming" as const,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const baseInvitation = (overrides: Record<string, unknown> = {}) => ({
  id: "inv_1",
  teamId: "team_1",
  invitedEmail: "invitee@example.com",
  invitedByUserId: "cand_captain",
  tokenHash: TOKEN_HASH,
  status: "pending" as const,
  expiresAt: FUTURE,
  acceptedAt: null,
  createdAt: NOW,
  ...overrides,
});

afterEach(() => vi.clearAllMocks());

describe("createTeam invariants", () => {
  it("rejects with team_competition_mode_not_allowed when mode is individual", async () => {
    const { db } = makeDb([[baseCompetition({ mode: "individual" })]]);
    await expect(
      createTeam("cand_1", "comp_1", { name: "Tim Alfa" }, db as never, NOW),
    ).rejects.toMatchObject({ code: "team_competition_mode_not_allowed" });
  });

  it("accepts mode = both", async () => {
    // Transaction inside createTeam runs the insert.values().returning() pattern. Wire the
    // tx mock to return a created team row.
    const { db: db2 } = makeDb([[baseCompetition({ mode: "both" })], []]);
    db2.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([baseTeam()]),
          }),
        })),
      };
      return cb(tx);
    });
    const result = await createTeam("cand_1", "comp_1", { name: "Tim Alfa" }, db2 as never, NOW);
    expect(result.id).toBe("team_1");
  });

  it("rejects with team_competition_not_published when competition is draft", async () => {
    const { db } = makeDb([[baseCompetition({ status: "draft" })]]);
    await expect(
      createTeam("cand_1", "comp_1", { name: "Tim Alfa" }, db as never, NOW),
    ).rejects.toMatchObject({ code: "team_competition_not_published" });
  });

  it("rejects with team_competition_registration_closed when deadline passed", async () => {
    const { db } = makeDb([[baseCompetition({ registrationEndAt: PAST })]]);
    await expect(
      createTeam("cand_1", "comp_1", { name: "Tim Alfa" }, db as never, NOW),
    ).rejects.toMatchObject({ code: "team_competition_registration_closed" });
  });

  it("rejects with team_competition_not_found when competition missing", async () => {
    const { db } = makeDb([[]]);
    await expect(
      createTeam("cand_1", "comp_missing", { name: "Tim" }, db as never, NOW),
    ).rejects.toMatchObject({ code: "team_competition_not_found" });
  });

  it("rejects with team_candidate_already_member when caller is on a team for this competition", async () => {
    const { db } = makeDb([[baseCompetition()], [{ teamId: "other_team" }]]);
    await expect(
      createTeam("cand_1", "comp_1", { name: "Tim" }, db as never, NOW),
    ).rejects.toMatchObject({ code: "team_candidate_already_member" });
  });

  it("translates a 23505 duplicate name into team_name_taken", async () => {
    const { db } = makeDb([[baseCompetition()], []]);
    db.transaction = vi.fn().mockImplementation(async () => {
      const err = Object.assign(new Error("dup"), { code: "23505" });
      throw err;
    });
    await expect(
      createTeam("cand_1", "comp_1", { name: "Dup" }, db as never, NOW),
    ).rejects.toMatchObject({ code: "team_name_taken" });
  });
});

describe("inviteTeamMember invariants", () => {
  it("rejects with team_not_captain when caller is not the captain", async () => {
    const { db } = makeDb([[baseTeam({ captainId: "other" })]]);
    await expect(
      inviteTeamMember("cand_imposter", "team_1", { invitedEmail: "x@y.io" }, db as never, NOW),
    ).rejects.toMatchObject({ code: "team_not_captain" });
  });

  it("rejects with team_not_forming when team status is cancelled", async () => {
    const { db } = makeDb([[baseTeam({ status: "cancelled" })]]);
    await expect(
      inviteTeamMember("cand_captain", "team_1", { invitedEmail: "x@y.io" }, db as never, NOW),
    ).rejects.toMatchObject({ code: "team_not_forming" });
  });

  it("rejects with team_at_capacity when seats used >= maxTeamSize (captain counts)", async () => {
    // selectQueue order: team, competition, activeCount, pendingCount
    const { db } = makeDb([
      [baseTeam()],
      [baseCompetition({ maxTeamSize: 2 })],
      [{ count: 1 }], // active members (captain)
      [{ count: 1 }], // pending invites (one outstanding)
    ]);
    await expect(
      inviteTeamMember(
        "cand_captain",
        "team_1",
        { invitedEmail: "fourth@y.io" },
        db as never,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "team_at_capacity" });
  });

  it("rejects with team_invite_already_pending when a pending invite for that email exists", async () => {
    const { db } = makeDb([
      [baseTeam()],
      [baseCompetition()],
      [{ count: 1 }],
      [{ count: 0 }],
      [], // existingActiveMember check
      [baseInvitation()], // existingPending — found
    ]);
    await expect(
      inviteTeamMember(
        "cand_captain",
        "team_1",
        { invitedEmail: "invitee@example.com" },
        db as never,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "team_invite_already_pending" });
  });

  it("rejects with team_competition_registration_closed when window has closed", async () => {
    const { db } = makeDb([[baseTeam()], [baseCompetition({ registrationEndAt: PAST })]]);
    await expect(
      inviteTeamMember(
        "cand_captain",
        "team_1",
        { invitedEmail: "invitee@example.com" },
        db as never,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "team_competition_registration_closed" });
  });
});

describe("acceptTeamInvitation invariants", () => {
  it("rejects with team_invite_not_found when token does not match any row", async () => {
    const { db } = makeDb([], { transactionSelectQueue: [[]] });
    await expect(acceptTeamInvitation(RAW_TOKEN, "cand_1", db as never, NOW)).rejects.toMatchObject(
      { code: "team_invite_not_found" },
    );
  });

  it("rejects with team_invite_not_actionable when expired", async () => {
    const { db } = makeDb([], {
      transactionSelectQueue: [[baseInvitation({ expiresAt: PAST })]],
    });
    await expect(acceptTeamInvitation(RAW_TOKEN, "cand_1", db as never, NOW)).rejects.toMatchObject(
      { code: "team_invite_not_actionable" },
    );
  });

  it("rejects with team_invite_not_actionable when status is declined", async () => {
    const { db } = makeDb([], {
      transactionSelectQueue: [[baseInvitation({ status: "declined" })]],
    });
    await expect(acceptTeamInvitation(RAW_TOKEN, "cand_1", db as never, NOW)).rejects.toMatchObject(
      { code: "team_invite_not_actionable" },
    );
  });

  it("rejects with team_not_forming when team is cancelled", async () => {
    const { db } = makeDb([], {
      transactionSelectQueue: [
        [baseInvitation()],
        [baseTeam({ status: "cancelled" })],
      ],
    });
    await expect(acceptTeamInvitation(RAW_TOKEN, "cand_1", db as never, NOW)).rejects.toMatchObject(
      { code: "team_not_forming" },
    );
  });

  it("rejects with team_invite_account_not_found when no account matches invited_email", async () => {
    const { db } = makeDb([], {
      transactionSelectQueue: [
        [baseInvitation()],
        [baseTeam()],
        [], // resolveByEmail — none
      ],
    });
    await expect(acceptTeamInvitation(RAW_TOKEN, "cand_1", db as never, NOW)).rejects.toMatchObject(
      { code: "team_invite_account_not_found" },
    );
  });

  it("rejects with team_invite_email_mismatch when session email differs from invited_email", async () => {
    const { db } = makeDb([], {
      transactionSelectQueue: [
        [baseInvitation()], // invitedEmail = invitee@example.com
        [baseTeam()],
        [{ id: "cand_invitee", email: "invitee@example.com" }],
        [{ id: "cand_other", email: "other@example.com" }], // session user — wrong email
      ],
    });
    await expect(
      acceptTeamInvitation(RAW_TOKEN, "cand_other", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_invite_email_mismatch" });
  });

  it("rejects with team_candidate_already_member when caller already has a team for this competition", async () => {
    const { db } = makeDb([], {
      transactionSelectQueue: [
        [baseInvitation()],
        [baseTeam()],
        [{ id: "cand_invitee", email: "invitee@example.com" }],
        [{ id: "cand_invitee", email: "invitee@example.com" }],
        [{ teamId: "other_team_for_same_competition" }],
      ],
    });
    await expect(
      acceptTeamInvitation(RAW_TOKEN, "cand_invitee", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_candidate_already_member" });
  });
});

describe("declineTeamInvitation", () => {
  it("rejects with team_invite_not_found when no row matches", async () => {
    const { db } = makeDb([[]]);
    await expect(declineTeamInvitation(RAW_TOKEN, db as never, NOW)).rejects.toMatchObject({
      code: "team_invite_not_found",
    });
  });

  it("rejects with team_invite_not_actionable when already accepted", async () => {
    const { db } = makeDb([[baseInvitation({ status: "accepted" })]]);
    await expect(declineTeamInvitation(RAW_TOKEN, db as never, NOW)).rejects.toMatchObject({
      code: "team_invite_not_actionable",
    });
  });

  it("declines a pending invitation", async () => {
    const { db } = makeDb([[baseInvitation()]]);
    await expect(declineTeamInvitation(RAW_TOKEN, db as never, NOW)).resolves.toBeUndefined();
  });
});

describe("removeTeamMember invariants", () => {
  it("rejects with team_captain_cannot_leave when membership row is the captain", async () => {
    const { db } = makeDb([
      [baseTeam()],
      [{ id: "mem_captain", teamId: "team_1", userId: "cand_captain", role: "captain", status: "active" }],
    ]);
    await expect(
      removeTeamMember("cand_captain", "team_1", "mem_captain", db as never),
    ).rejects.toMatchObject({ code: "team_captain_cannot_leave" });
  });

  it("rejects with team_not_forming when team has been cancelled", async () => {
    const { db } = makeDb([[baseTeam({ status: "cancelled" })]]);
    await expect(
      removeTeamMember("cand_captain", "team_1", "mem_other", db as never),
    ).rejects.toMatchObject({ code: "team_not_forming" });
  });

  it("allows captain to remove a non-captain member", async () => {
    const { db } = makeDb([
      [baseTeam()],
      [{ id: "mem_other", teamId: "team_1", userId: "cand_other", role: "member", status: "active" }],
    ]);
    await expect(
      removeTeamMember("cand_captain", "team_1", "mem_other", db as never),
    ).resolves.toBeUndefined();
  });

  it("allows a member to leave voluntarily", async () => {
    const { db } = makeDb([
      [baseTeam()],
      [{ id: "mem_self", teamId: "team_1", userId: "cand_self", role: "member", status: "active" }],
    ]);
    await expect(
      removeTeamMember("cand_self", "team_1", "mem_self", db as never),
    ).resolves.toBeUndefined();
  });

  it("rejects with team_forbidden when caller is neither captain nor the member themselves", async () => {
    const { db } = makeDb([
      [baseTeam()],
      [{ id: "mem_other", teamId: "team_1", userId: "cand_other", role: "member", status: "active" }],
    ]);
    await expect(
      removeTeamMember("cand_imposter", "team_1", "mem_other", db as never),
    ).rejects.toMatchObject({ code: "team_forbidden" });
  });
});

describe("disbandTeam invariants", () => {
  it("rejects with team_not_captain when caller is not the captain", async () => {
    const { db } = makeDb([[baseTeam()]]);
    await expect(disbandTeam("cand_imposter", "team_1", db as never, NOW)).rejects.toMatchObject({
      code: "team_not_captain",
    });
  });

  it("rejects with team_not_forming on a cancelled team", async () => {
    const { db } = makeDb([[baseTeam({ status: "cancelled" })]]);
    await expect(disbandTeam("cand_captain", "team_1", db as never, NOW)).rejects.toMatchObject({
      code: "team_not_forming",
    });
  });

  it("disbands a forming team owned by the caller", async () => {
    const { db } = makeDb([[baseTeam()]]);
    await expect(disbandTeam("cand_captain", "team_1", db as never, NOW)).resolves.toBeUndefined();
  });
});
