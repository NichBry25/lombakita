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

// The predicate deciding whether a priced registration may still self-cancel. Mocked here because
// this file tests cancelRegistration's OWN gate ORDER against a queued fake with no proof tables;
// that the predicate reads a real proof row, and that both of its answers drive the right outcome,
// is proven against a live Postgres in the manual-lane integration suite.
const { hasSubmittedPaymentProof } = vi.hoisted(() => ({
  hasSubmittedPaymentProof: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/server/finance/paid-registration", () => ({ hasSubmittedPaymentProof }));

import {
  cancelRegistration,
  createIndividualRegistration,
  getStudentRegistration,
} from "./registration-service";
import { RegistrationError } from "./registration-core";

type CompetitionRow = {
  id: string;
  status: "draft" | "published" | "archived";
  mode: "individual" | "team" | "both" | null;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
  participantConfirmationAt: Date | null;
  cancelledAt: Date | null;
  allowCancellation: boolean;
  cancellationCutoffDays: number | null;
  feeAmount: number | null;
};

type RegistrationRow = {
  id: string;
  competitionId: string;
  studentId: string;
  registrationType: "individual" | "team";
  status: "confirmed" | "cancelled" | "pending_payment";
  registeredAt: Date;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const NOW = new Date("2026-05-10T12:00:00.000Z");

const baseCompetition = (overrides: Partial<CompetitionRow> = {}): CompetitionRow => ({
  id: "comp_1",
  status: "published",
  mode: "individual",
  registrationEndAt: FUTURE,
  eventStartAt: FUTURE,
  participantConfirmationAt: null,
  cancelledAt: null,
  allowCancellation: false,
  cancellationCutoffDays: null,
  feeAmount: null,
  ...overrides,
});

const baseRegistration = (overrides: Partial<RegistrationRow> = {}): RegistrationRow => ({
  id: "reg_1",
  competitionId: "comp_1",
  studentId: "stud_1",
  registrationType: "individual",
  status: "confirmed",
  registeredAt: NOW,
  cancelledAt: null,
  cancellationReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

// Build a queueing select() mock. Each call returns a select chain whose .limit() resolves to
// the next pre-queued row set. This lets us stage the multi-SELECT enforcement chain
// (competition load, existing-registration check, cancel re-load).
const makeQueuedDb = (
  selectQueue: Array<unknown[]>,
  options: {
    insertReturning?: RegistrationRow[];
    updateReturning?: RegistrationRow[];
    insertError?: unknown;
  } = {},
) => {
  const selectCallTraces: Array<unknown[]> = [];

  const select = vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    selectCallTraces.push(result);

    const limit = vi.fn().mockResolvedValue(result);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ limit, orderBy });
    const from = vi.fn().mockReturnValue({ where });

    return { from };
  });

  const insertReturning = vi.fn().mockResolvedValue(options.insertReturning ?? []);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const insert = vi.fn(() => {
    if (options.insertError) {
      return {
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(options.insertError),
        }),
      };
    }
    return { values: insertValues };
  });

  const updateReturning = vi.fn().mockResolvedValue(options.updateReturning ?? []);
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  const db = {
    select,
    insert,
    update,
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ select, insert, update }),
    ),
  };

  return {
    db,
    spies: {
      select,
      insertValues,
      insertReturning,
      updateSet,
      updateReturning,
      selectCallTraces,
    },
  };
};

describe("getStudentRegistration", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the row when one exists", async () => {
    const reg = baseRegistration();
    const { db } = makeQueuedDb([[reg]]);

    const result = await getStudentRegistration("stud_1", "comp_1", db as never);
    expect(result).toEqual(reg);
  });

  it("returns null when no row exists", async () => {
    const { db } = makeQueuedDb([[]]);

    const result = await getStudentRegistration("stud_1", "comp_1", db as never);
    expect(result).toBeNull();
  });
});

describe("createIndividualRegistration enforcement chain", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the inserted record on the happy path", async () => {
    const inserted = baseRegistration();
    const { db, spies } = makeQueuedDb(
      [
        [baseCompetition()], // load competition
        [], // existing-registration check → none
        [baseCompetition()], // locked deadline re-check
      ],
      { insertReturning: [inserted] },
    );

    const result = await createIndividualRegistration("stud_1", "comp_1", db as never, NOW);

    expect(result).toEqual(inserted);
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        competitionId: "comp_1",
        studentId: "stud_1",
        registrationType: "individual",
        status: "confirmed",
      }),
    );
  });

  // Open-candidacy negative contract (DEC-0106): there is no age band and no eligibility
  // gate. A candidate who would have been blocked under the retired 18–32 rule must be able
  // to register. The service never receives a date of birth and must never look one up: the
  // only SELECTs on the happy path are the competition load, duplicate-registration check, the
  // locked deadline re-check, and the pricing read that decides whether a payment is owed. If a
  // future change reintroduces an age/eligibility lookup, either registration stops succeeding or
  // another SELECT appears here, and both fail this test.
  it("allows a candidate over 32 to register (no age/eligibility gate, DEC-0106)", async () => {
    const inserted = baseRegistration({ studentId: "candidate_over_32" });
    const { db, spies } = makeQueuedDb(
      [
        [baseCompetition()], // load competition
        [], // existing-registration check → none
        [baseCompetition()], // locked deadline re-check
      ],
      { insertReturning: [inserted] },
    );

    const result = await createIndividualRegistration(
      "candidate_over_32",
      "comp_1",
      db as never,
      NOW,
    );

    expect(result).toEqual(inserted);
    // No profile/age/eligibility SELECT was issued. Four reads: the three enforcement-chain ones
    // plus the pricing read that decides whether this registration owes a payment.
    expect(spies.selectCallTraces).toHaveLength(4);
  });

  it("rejects with competition_not_found when competition does not exist", async () => {
    const { db } = makeQueuedDb([[]]);

    await expect(
      createIndividualRegistration("stud_1", "missing", db as never, NOW),
    ).rejects.toMatchObject({ code: "competition_not_found" });
  });

  it("rejects with competition_not_published when status is draft", async () => {
    const { db } = makeQueuedDb([[baseCompetition({ status: "draft" })]]);

    await expect(
      createIndividualRegistration("stud_1", "comp_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "competition_not_published" });
  });

  it("rejects with competition_not_published when status is archived", async () => {
    const { db } = makeQueuedDb([[baseCompetition({ status: "archived" })]]);

    await expect(
      createIndividualRegistration("stud_1", "comp_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "competition_not_published" });
  });

  it("rejects with competition_wrong_mode when mode is team", async () => {
    const { db } = makeQueuedDb([[baseCompetition({ mode: "team" })]]);

    await expect(
      createIndividualRegistration("stud_1", "comp_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "competition_wrong_mode" });
  });

  it("accepts mode 'both' (individual entry permitted)", async () => {
    const inserted = baseRegistration();
    const bothCompetition = baseCompetition({ mode: "both" });
    const { db } = makeQueuedDb([[bothCompetition], [], [bothCompetition]], {
      insertReturning: [inserted],
    });

    const result = await createIndividualRegistration("stud_1", "comp_1", db as never, NOW);
    expect(result).toEqual(inserted);
  });

  it("re-checks the deadline after acquiring the participation lock", async () => {
    const { db, spies } = makeQueuedDb([
      [baseCompetition()],
      [],
      [baseCompetition({ registrationEndAt: NOW })],
    ]);

    await expect(
      createIndividualRegistration("stud_1", "comp_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_deadline_passed" });
    expect(spies.insertValues).not.toHaveBeenCalled();
  });

  it("rejects with registration_deadline_passed when deadline is in the past", async () => {
    const { db } = makeQueuedDb([[baseCompetition({ registrationEndAt: PAST })]]);

    await expect(
      createIndividualRegistration("stud_1", "comp_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_deadline_passed" });
  });

  it("rejects with registration_deadline_passed when deadline is null", async () => {
    const { db } = makeQueuedDb([[baseCompetition({ registrationEndAt: null })]]);

    await expect(
      createIndividualRegistration("stud_1", "comp_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_deadline_passed" });
  });

  it("rejects with registration_already_exists when a confirmed registration exists", async () => {
    const { db } = makeQueuedDb([
      [baseCompetition()],
      [{ id: "reg_existing", status: "confirmed" }],
    ]);

    await expect(
      createIndividualRegistration("stud_1", "comp_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_already_exists" });
  });

  it("blocks re-registration after cancellation (deferred to future hardening)", async () => {
    const { db } = makeQueuedDb([
      [baseCompetition()],
      [{ id: "reg_existing", status: "cancelled" }],
    ]);

    await expect(
      createIndividualRegistration("stud_1", "comp_1", db as never, NOW),
    ).rejects.toMatchObject({
      code: "registration_already_exists",
      details: { existingStatus: "cancelled" },
    });
  });

  it("translates Postgres unique-violation 23505 to registration_already_exists", async () => {
    const { db } = makeQueuedDb([[baseCompetition()], [], [baseCompetition()]], {
      insertError: Object.assign(new Error("dup"), { code: "23505" }),
    });

    await expect(
      createIndividualRegistration("stud_1", "comp_1", db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_already_exists" });
  });
});

describe("cancelRegistration enforcement chain", () => {
  afterEach(() => vi.clearAllMocks());

  it("cancels a confirmed registration within the cancellation window (F12)", async () => {
    const reg = baseRegistration();
    const updated = baseRegistration({
      status: "cancelled",
      cancelledAt: NOW,
      cancellationReason: "test",
    });
    const { db, spies } = makeQueuedDb(
      [
        [reg],
        [
          baseCompetition({
            allowCancellation: true,
            cancellationCutoffDays: 7,
            eventStartAt: FUTURE,
          }),
        ],
        [
          baseCompetition({
            allowCancellation: true,
            cancellationCutoffDays: 7,
            eventStartAt: FUTURE,
          }),
        ],
      ],
      { updateReturning: [updated] },
    );

    const result = await cancelRegistration("stud_1", "comp_1", "reg_1", "test", db as never, NOW);

    expect(result.status).toBe("cancelled");
    expect(spies.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
        cancelledAt: NOW,
        cancellationReason: "test",
      }),
    );
  });

  it("re-checks participantConfirmationAt after acquiring the participation lock", async () => {
    const reg = baseRegistration();
    const beforeConfirmation = baseCompetition({
      allowCancellation: true,
      cancellationCutoffDays: 7,
      eventStartAt: FUTURE,
      participantConfirmationAt: FUTURE,
    });
    const { db, spies } = makeQueuedDb([
      [reg],
      [beforeConfirmation],
      [
        baseCompetition({
          allowCancellation: true,
          cancellationCutoffDays: 7,
          eventStartAt: FUTURE,
          participantConfirmationAt: NOW,
        }),
      ],
    ]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", "test", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_window_closed" });
    expect(spies.updateSet).not.toHaveBeenCalled();
  });

  it("rejects with registration_not_found when registration is missing", async () => {
    const { db } = makeQueuedDb([[]]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", null, db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_not_found" });
  });

  it("rejects with registration_not_found when registration belongs to a different competition", async () => {
    const reg = baseRegistration({ competitionId: "comp_other" });
    const { db } = makeQueuedDb([[reg]]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", null, db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_not_found" });
  });

  it("rejects with registration_not_owner when caller is not the candidate on the row", async () => {
    const reg = baseRegistration({ studentId: "other_student" });
    const { db } = makeQueuedDb([[reg]]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", null, db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_not_owner" });
  });

  it("rejects with registration_wrong_status when already cancelled", async () => {
    const reg = baseRegistration({ status: "cancelled" });
    const { db } = makeQueuedDb([[reg]]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", null, db as never, NOW),
    ).rejects.toMatchObject({ code: "registration_wrong_status" });
  });

  it("rejects with cancellation_reason_required when reason is missing (after ownership + status)", async () => {
    const reg = baseRegistration();
    // Only the registration is loaded — the reason gate fires before the competition is read.
    const { db } = makeQueuedDb([[reg]]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", null, db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_reason_required" });
  });

  it("rejects with cancellation_reason_too_long when reason exceeds 500 chars", async () => {
    const reg = baseRegistration();
    const { db } = makeQueuedDb([[reg]]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", "a".repeat(501), db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_reason_too_long" });
  });

  it("rejects with cancellation_not_supported_for_paid once a bukti transfer has been submitted", async () => {
    hasSubmittedPaymentProof.mockResolvedValueOnce(true);
    const reg = baseRegistration();
    const { db } = makeQueuedDb([
      [reg],
      [
        baseCompetition({
          feeAmount: 50_000,
          allowCancellation: true,
          cancellationCutoffDays: 0,
          eventStartAt: FUTURE,
        }),
      ],
    ]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", "ganti rencana", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_not_supported_for_paid" });
  });

  it("lets a paid registration with NO bukti transfer past the paid gate", async () => {
    // The other half of the conditional. Without this the refusal above would also pass against
    // the blanket rule this replaced, which stripped the right to leave from a candidate who had
    // registered, transferred nothing, and simply changed their mind.
    hasSubmittedPaymentProof.mockResolvedValueOnce(false);
    const reg = baseRegistration();
    const { db } = makeQueuedDb([
      [reg],
      [
        baseCompetition({
          feeAmount: 50_000,
          // Refused by the NEXT gate, which is how we know the paid gate let it through: a
          // still-blanket paid gate would report cancellation_not_supported_for_paid instead.
          allowCancellation: false,
        }),
      ],
    ]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", "ganti rencana", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_disabled_by_institution" });
  });

  it("rejects with cancellation_disabled_by_institution when allow_cancellation is false", async () => {
    const reg = baseRegistration();
    const { db } = makeQueuedDb([[reg], [baseCompetition({ allowCancellation: false })]]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", "ganti rencana", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_disabled_by_institution" });
  });

  it("rejects with cancellation_window_closed past the cutoff", async () => {
    const reg = baseRegistration();
    // Event starts 2 days after NOW; a 7-day cutoff puts the window end before NOW.
    const eventSoon = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const { db } = makeQueuedDb([
      [reg],
      [
        baseCompetition({
          allowCancellation: true,
          cancellationCutoffDays: 7,
          eventStartAt: eventSoon,
        }),
      ],
    ]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", "ganti rencana", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_window_closed" });
  });

  it("rejects at participantConfirmationAt even when the older cutoff remains open", async () => {
    const reg = baseRegistration();
    const { db } = makeQueuedDb([
      [reg],
      [
        baseCompetition({
          allowCancellation: true,
          cancellationCutoffDays: 0,
          participantConfirmationAt: NOW,
        }),
      ],
    ]);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", "ganti rencana", db as never, NOW),
    ).rejects.toMatchObject({ code: "cancellation_window_closed" });
  });
});

describe("RegistrationError shape", () => {
  it("carries code, message, status, and details", () => {
    const err = new RegistrationError("cancellation_reason_required", "msg", { reasons: ["x"] });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("cancellation_reason_required");
    expect(err.status).toBe(422);
    expect(err.details).toEqual({ reasons: ["x"] });
  });
});
