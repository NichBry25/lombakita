// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetDb } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/competitions/competition-participation-lock", () => ({
  acquireCompetitionParticipationLock: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The predicate deciding whether a priced team registration may still be reverted. Mocked for the
// same reason the individual path mocks it: this file tests cancelTeamRegistration's gate ORDER
// against a queued fake with no proof tables. That a team's proof resolves across the whole payment
// group — one payment anchored on the captain's row, every member's row in the same group — is
// proven against a live Postgres in the manual-lane integration suite.
const { hasSubmittedPaymentProof, findTeamPaymentGroupAnchor } = vi.hoisted(() => ({
  hasSubmittedPaymentProof: vi.fn().mockResolvedValue(false),
  // A team always has an anchor row here; the no-rows case is covered against a real database.
  findTeamPaymentGroupAnchor: vi.fn().mockResolvedValue("reg-anchor"),
}));
vi.mock("@/server/finance/paid-registration", () => ({
  hasSubmittedPaymentProof,
  findTeamPaymentGroupAnchor,
}));

import { cancelTeamRegistration, submitTeamRegistration } from "./team-registration-service";

type SelectResult = unknown[];

const NOW = new Date("2026-06-01T12:00:00.000Z");
const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");

// Build a chainable db.select mock that returns one queued row set per .select() call.
const buildSelect = (queue: SelectResult[]) =>
  vi.fn(() => {
    const result = queue.shift() ?? [];
    const limit = vi.fn().mockResolvedValue(result);
    const whereChain: Record<string, unknown> = {
      limit,
      then: (cb: (value: unknown) => unknown) => Promise.resolve(result).then(cb),
    };
    const where = vi.fn().mockReturnValue(whereChain);
    const fromChain = { where, innerJoin: vi.fn().mockReturnThis(), limit };
    Object.assign(fromChain, { where });
    const from = vi.fn().mockReturnValue(fromChain);
    return { from };
  });

type DbOptions = {
  txInsertReturning?: unknown[];
  txTeamUpdateReturning?: unknown[];
  txInsertError?: unknown;
  txUpdateReturning?: unknown[];
  txCompetitionReturning?: unknown[];
};

const makeDb = (selectQueue: SelectResult[], options: DbOptions = {}) => {
  const select = buildSelect(selectQueue);

  const tx = {
    select: buildSelect([options.txCompetitionReturning ?? [competition()]]),
    insert: vi.fn(() => {
      if (options.txInsertError) {
        return {
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(options.txInsertError),
          }),
        };
      }
      return {
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(options.txInsertReturning ?? []),
        }),
      };
    }),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValueOnce(
              options.txTeamUpdateReturning ?? options.txUpdateReturning ?? [],
            ),
        }),
      }),
    })),
  };

  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb(tx);
  });

  return { db: { select, transaction }, tx };
};

const team = (over: Record<string, unknown> = {}) => ({
  id: "team_1",
  competitionId: "comp_1",
  captainId: "cap_1",
  status: "forming",
  ...over,
});

const competition = (over: Record<string, unknown> = {}) => ({
  id: "comp_1",
  status: "published",
  mode: "team",
  minTeamSize: 2,
  maxTeamSize: 4,
  registrationStartAt: PAST,
  registrationEndAt: FUTURE,
  eventStartAt: FUTURE,
  participantConfirmationAt: null,
  cancelledAt: null,
  allowCancellation: true,
  cancellationCutoffDays: 7,
  feeAmount: null,
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("submitTeamRegistration — pre-transaction gates", () => {
  it("rejects team_not_found when team is missing", async () => {
    const { db } = makeDb([[]]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "missing", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_not_found" });
  });

  it("returns 404 (team_not_found) when teamId belongs to another competition", async () => {
    const { db } = makeDb([[team({ competitionId: "comp_OTHER" })]]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_not_found" });
  });

  it("returns 403 (team_not_captain) when caller is not the captain", async () => {
    const { db } = makeDb([[team()]]);
    await expect(
      submitTeamRegistration("not_cap", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_not_captain" });
  });

  it("rejects team_not_forming when team is submitted", async () => {
    const { db } = makeDb([[team({ status: "submitted" })]]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_not_forming" });
  });

  it("rejects team_competition_not_found when competition missing", async () => {
    const { db } = makeDb([[team()], []]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_competition_not_found" });
  });

  it("rejects team_competition_not_published when status is draft", async () => {
    const { db } = makeDb([[team()], [competition({ status: "draft" })]]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_competition_not_published" });
  });

  it("rejects team_registration_not_allowed when mode is individual", async () => {
    const { db } = makeDb([[team()], [competition({ mode: "individual" })]]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_registration_not_allowed" });
  });

  it("rejects registration_not_yet_open when before window start", async () => {
    const { db } = makeDb([[team()], [competition({ registrationStartAt: FUTURE })]]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_not_yet_open" });
  });

  it("rejects registration_window_closed when after window end", async () => {
    const { db } = makeDb([[team()], [competition({ registrationEndAt: PAST })]]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_window_closed" });
  });

  it("rejects team_size_insufficient when below minTeamSize", async () => {
    const { db } = makeDb([
      [team()],
      [competition({ minTeamSize: 3 })],
      [{ membershipId: "m1", userId: "u1" }], // only 1 member
    ]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_size_insufficient" });
  });

  it("rejects team_size_exceeded when above maxTeamSize", async () => {
    const { db } = makeDb([
      [team()],
      [competition({ maxTeamSize: 2 })],
      [
        { membershipId: "m1", userId: "u1" },
        { membershipId: "m2", userId: "u2" },
        { membershipId: "m3", userId: "u3" },
      ],
    ]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_size_exceeded" });
  });

  it("skips size checks when min/max are null", async () => {
    // Compose: team, competition (null bounds), 1 member, no existing regs.
    const { db } = makeDb(
      [
        [team()],
        [competition({ minTeamSize: null, maxTeamSize: null })],
        [{ membershipId: "m1", userId: "cap_1" }],
        [], // existing regs
      ],
      {
        txInsertReturning: [{ id: "reg_1", studentId: "cap_1", status: "confirmed" }],
        txTeamUpdateReturning: [{ id: "team_1" }],
      },
    );
    const result = await submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW);
    expect(result.status).toBe("submitted");
  });

  // Open-candidacy negative contract (DEC-0106): team submission applies no per-member age
  // or eligibility gate. A team whose members would all have failed the retired 18–32 rule
  // must still submit. Members are loaded as {membershipId, userId} only — no date of birth
  // is read for any member. If a future change reintroduces a member-eligibility check, this
  // team stops submitting and the test fails.
  it("allows a team of members over 32 to submit (no member eligibility gate — DEC-0106)", async () => {
    const { db } = makeDb(
      [
        [team()],
        [competition()],
        [
          { membershipId: "m1", userId: "cap_1" },
          { membershipId: "m2", userId: "u_member_over_32" },
        ],
        [], // existing regs → none
      ],
      {
        txInsertReturning: [
          { id: "reg_1", studentId: "cap_1", status: "confirmed" },
          { id: "reg_2", studentId: "u_member_over_32", status: "confirmed" },
        ],
        txTeamUpdateReturning: [{ id: "team_1" }],
      },
    );

    const result = await submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW);

    expect(result.status).toBe("submitted");
    expect(result.registrations).toHaveLength(2);
  });

  it("rejects team_member_already_registered when a member has a non-cancelled registration", async () => {
    const { db } = makeDb([
      [team()],
      [competition()],
      [
        { membershipId: "m1", userId: "cap_1" },
        { membershipId: "m2", userId: "u_member" },
      ],
      [{ studentId: "u_member", status: "confirmed" }], // existing reg
    ]);
    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({
      code: "team_member_already_registered",
      details: expect.objectContaining({
        conflictingMembers: ["u_member"],
      }),
    });
  });

  it("ignores cancelled prior registrations and proceeds", async () => {
    const { db } = makeDb(
      [
        [team()],
        [competition()],
        [
          { membershipId: "m1", userId: "cap_1" },
          { membershipId: "m2", userId: "u_member" },
        ],
        [{ studentId: "u_member", status: "cancelled" }], // cancelled — not a conflict
      ],
      {
        txInsertReturning: [
          { id: "reg_1", studentId: "cap_1", status: "confirmed" },
          { id: "reg_2", studentId: "u_member", status: "confirmed" },
        ],
        txTeamUpdateReturning: [{ id: "team_1" }],
      },
    );
    const result = await submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW);
    expect(result.status).toBe("submitted");
    expect(result.registrations.length).toBe(2);
  });
});

describe("submitTeamRegistration — transactional behaviour", () => {
  it("re-checks the registration deadline after acquiring the participation lock", async () => {
    const { db } = makeDb(
      [
        [team()],
        [competition()],
        [
          { membershipId: "m1", userId: "cap_1" },
          { membershipId: "m2", userId: "u_2" },
        ],
        [],
      ],
      { txCompetitionReturning: [competition({ registrationEndAt: NOW })] },
    );

    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_window_closed" });
  });

  it("returns submitted result on the happy path", async () => {
    const { db, tx } = makeDb(
      [
        [team()],
        [competition()],
        [
          { membershipId: "m1", userId: "cap_1" },
          { membershipId: "m2", userId: "u_member" },
        ],
        [],
      ],
      {
        txInsertReturning: [
          { id: "reg_1", studentId: "cap_1", status: "confirmed" },
          { id: "reg_2", studentId: "u_member", status: "confirmed" },
        ],
        txTeamUpdateReturning: [{ id: "team_1" }],
      },
    );

    const result = await submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW);
    expect(result).toEqual({
      teamId: "team_1",
      status: "submitted",
      registrations: [
        { id: "reg_1", studentId: "cap_1", status: "confirmed" },
        { id: "reg_2", studentId: "u_member", status: "confirmed" },
      ],
    });
    expect(tx.insert).toHaveBeenCalled();
    expect(tx.update).toHaveBeenCalled();
  });

  it("throws team_state_conflict when TOCTOU race leaves CAS UPDATE rowless", async () => {
    const { db } = makeDb(
      [[team()], [competition({ minTeamSize: 1 })], [{ membershipId: "m1", userId: "cap_1" }], []],
      {
        txInsertReturning: [{ id: "reg_1", studentId: "cap_1", status: "confirmed" }],
        txTeamUpdateReturning: [], // CAS returned 0 rows
      },
    );

    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_state_conflict" });
  });

  it("translates Postgres 23505 to team_member_already_registered", async () => {
    const { db } = makeDb(
      [[team()], [competition({ minTeamSize: 1 })], [{ membershipId: "m1", userId: "cap_1" }], []],
      {
        txInsertError: Object.assign(new Error("dup"), { code: "23505" }),
      },
    );

    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_member_already_registered" });
  });

  // 4.4-Sch-M1 — defense-in-depth: surface a typed 422 if the CHECK constraint ever fires.
  it("translates Postgres 23514 (CHECK violation) to team_registration_invariant_violation", async () => {
    const { db } = makeDb(
      [[team()], [competition({ minTeamSize: 1 })], [{ membershipId: "m1", userId: "cap_1" }], []],
      {
        txInsertError: Object.assign(new Error("check failed"), { code: "23514" }),
      },
    );

    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({
      code: "team_registration_invariant_violation",
      status: 422,
    });
  });

  // Drizzle wraps the underlying pg error; verify the unwrap path also surfaces 23514 cleanly.
  it("translates Drizzle-wrapped 23514 (in .cause.code) to team_registration_invariant_violation", async () => {
    const wrapped = Object.assign(new Error("DrizzleQueryError"), {
      cause: { code: "23514" },
    });
    const { db } = makeDb(
      [[team()], [competition({ minTeamSize: 1 })], [{ membershipId: "m1", userId: "cap_1" }], []],
      { txInsertError: wrapped },
    );

    await expect(
      submitTeamRegistration("cap_1", "comp_1", "team_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_registration_invariant_violation" });
  });
});

describe("cancelTeamRegistration", () => {
  it("rejects team_not_found when team is missing", async () => {
    const { db } = makeDb([[]]);
    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_not_found" });
  });

  it("returns 404 (team_not_found) when teamId belongs to another competition", async () => {
    const { db } = makeDb([[team({ competitionId: "comp_OTHER", status: "submitted" })]]);
    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_not_found" });
  });

  it("returns 403 (team_not_captain) when caller is not the captain", async () => {
    const { db } = makeDb([[team({ status: "submitted" })]]);
    await expect(
      cancelTeamRegistration("not_cap", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_not_captain" });
  });

  it("rejects team_not_submitted when status is forming", async () => {
    const { db } = makeDb([[team({ status: "forming" })]]);
    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_not_submitted" });
  });

  it("rejects cancellation_reason_required when reason is missing (after captain + status gates)", async () => {
    const { db } = makeDb([[team({ status: "submitted" })]]);
    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", null, db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_reason_required" });
  });

  it("rejects cancellation_disabled_by_institution when allow_cancellation is false", async () => {
    const { db } = makeDb([
      [team({ status: "submitted" })],
      [competition({ allowCancellation: false })],
    ]);
    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_disabled_by_institution" });
  });

  it("rejects cancellation_not_supported_for_paid once the team's bukti transfer is submitted", async () => {
    hasSubmittedPaymentProof.mockResolvedValueOnce(true);
    const { db } = makeDb([
      [team({ status: "submitted" })],
      [competition({ feeAmount: 50_000 })],
      // The group-member lookup the paid gate makes before asking the predicate.
      [{ id: "reg_1" }],
    ]);
    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_not_supported_for_paid" });
  });

  it("lets a paid team with NO bukti transfer past the paid gate", async () => {
    // The captain and a solo entrant on the same competition, both having transferred nothing, must
    // get the same answer. This arm was left blanket while the individual arm became conditional in
    // an earlier draft, and this is the test that would have caught it.
    hasSubmittedPaymentProof.mockResolvedValueOnce(false);
    const { db } = makeDb([
      [team({ status: "submitted" })],
      [competition({ feeAmount: 50_000, allowCancellation: false })],
      [{ id: "reg_1" }],
    ]);
    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_disabled_by_institution" });
  });

  it("rejects cancellation_window_closed past the cutoff", async () => {
    const eventSoon = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const { db } = makeDb([
      [team({ status: "submitted" })],
      [competition({ cancellationCutoffDays: 7, eventStartAt: eventSoon })],
    ]);
    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_window_closed" });
  });

  it("rejects cancellation at participantConfirmationAt even when the older cutoff remains open", async () => {
    const { db } = makeDb([
      [team({ status: "submitted" })],
      [
        competition({
          cancellationCutoffDays: 0,
          participantConfirmationAt: NOW,
        }),
      ],
    ]);

    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_window_closed" });
  });

  it("re-checks participantConfirmationAt after acquiring the participation lock", async () => {
    const beforeConfirmation = competition({
      participantConfirmationAt: FUTURE,
      allowCancellation: true,
      cancellationCutoffDays: 7,
    });
    const { db } = makeDb([[team({ status: "submitted" })], [beforeConfirmation]], {
      txCompetitionReturning: [
        competition({
          participantConfirmationAt: NOW,
          allowCancellation: true,
          cancellationCutoffDays: 7,
        }),
      ],
    });

    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_window_closed" });
  });

  it("cancels registrations and reverts team to forming on happy path", async () => {
    // tx.update is called twice (registrations cancel, then team revert). Both need returning().
    const { db } = makeDb([[team({ status: "submitted" })], [competition()]]);
    db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const updateCalls: number[] = [];
      const tx = {
        select: buildSelect([[competition()]]),
        update: vi.fn(() => {
          updateCalls.push(1);
          if (updateCalls.length === 1) {
            // cancel registrations
            return {
              set: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  returning: vi
                    .fn()
                    .mockResolvedValue([{ id: "reg_1", studentId: "cap_1", status: "cancelled" }]),
                }),
              }),
            };
          }
          // team CAS update
          return {
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: "team_1" }]),
              }),
            }),
          };
        }),
      };
      return cb(tx);
    });

    const result = await cancelTeamRegistration(
      "cap_1",
      "comp_1",
      "team_1",
      "berhalangan hadir",
      db as never,
      NOW,
    );
    expect(result.status).toBe("forming");
    expect(result.registrations).toEqual([
      { id: "reg_1", studentId: "cap_1", status: "cancelled" },
    ]);
  });

  it("throws team_state_conflict when team CAS UPDATE returns 0 rows", async () => {
    const { db } = makeDb([[team({ status: "submitted" })], [competition()]]);
    db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const updateCalls: number[] = [];
      const tx = {
        select: buildSelect([[competition()]]),
        update: vi.fn(() => {
          updateCalls.push(1);
          if (updateCalls.length === 1) {
            return {
              set: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  returning: vi.fn().mockResolvedValue([]),
                }),
              }),
            };
          }
          return {
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([]), // CAS returned 0
              }),
            }),
          };
        }),
      };
      return cb(tx);
    });

    await expect(
      cancelTeamRegistration("cap_1", "comp_1", "team_1", "alasan", db as never, NOW),
    ).rejects.toMatchObject({ code: "team_state_conflict" });
  });
});
