// @vitest-environment node
// Tests that registration.confirmed and registration.cancelled enqueue calls are
// fire-and-forget: called exactly once on the happy path, not called on failure
// paths, and enqueue failure does not surface to the caller.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, enqueueRegistrationConfirmed, enqueueRegistrationCancelled } = vi.hoisted(
  () => ({
    mockGetDb: vi.fn(),
    enqueueRegistrationConfirmed: vi.fn(),
    enqueueRegistrationCancelled: vi.fn(),
  }),
);

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/async/enqueue", () => ({
  enqueueRegistrationConfirmed,
  enqueueRegistrationCancelled,
}));
vi.mock("@/server/competitions/competition-participation-lock", () => ({
  acquireCompetitionParticipationLock: vi.fn(),
}));

import { createIndividualRegistration, cancelRegistration } from "./registration-service";
import { RegistrationError } from "./registration-core";

const FUTURE = new Date("2026-12-01T00:00:00.000Z");
const NOW = new Date("2026-05-10T12:00:00.000Z");

const confirmedReg = {
  id: "reg_1",
  competitionId: "comp_1",
  studentId: "stud_1",
  registrationType: "individual" as const,
  status: "confirmed" as const,
  registeredAt: NOW,
  cancelledAt: null,
  cancellationReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

// Minimal FIFO DB mock — each select() call returns the next queued rows.
const makeDb = (
  selectQueues: unknown[][],
  opts: { insertReturn?: unknown[]; updateReturn?: unknown[] } = {},
) => {
  const queue = [...selectQueues];
  const select = vi.fn(() => {
    const rows = queue.shift() ?? [];
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ limit, orderBy });
    return { from: vi.fn().mockReturnValue({ where }) };
  });
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(opts.insertReturn ?? []),
    }),
  });
  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(opts.updateReturn ?? []),
      }),
    }),
  });
  const db = { select, insert, update } as {
    select: typeof select;
    insert: typeof insert;
    update: typeof update;
    transaction: ReturnType<typeof vi.fn>;
  };
  db.transaction = vi.fn(async (callback: (tx: typeof db) => unknown) => callback(db));
  return db;
};

describe("createIndividualRegistration — notification enqueue", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("calls enqueueRegistrationConfirmed once on successful registration", async () => {
    enqueueRegistrationConfirmed.mockResolvedValue({});
    const db = makeDb(
      [
        [{ id: "comp_1", status: "published", mode: "individual", registrationEndAt: FUTURE }],
        [], // no existing registration
        [{ id: "comp_1", status: "published", mode: "individual", registrationEndAt: FUTURE }],
      ],
      { insertReturn: [confirmedReg] },
    );
    mockGetDb.mockReturnValue(db);

    await createIndividualRegistration("stud_1", "comp_1", db as never, NOW);

    expect(enqueueRegistrationConfirmed).toHaveBeenCalledOnce();
    expect(enqueueRegistrationConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: "reg_1", registrationType: "individual" }),
    );
  });

  it("does NOT call enqueueRegistrationConfirmed when duplicate registration exists", async () => {
    const db = makeDb([
      [{ id: "comp_1", status: "published", mode: "individual", registrationEndAt: FUTURE }],
      [{ id: "reg_existing", status: "confirmed" }],
    ]);
    mockGetDb.mockReturnValue(db);

    await expect(
      createIndividualRegistration("stud_1", "comp_1", db as never, NOW),
    ).rejects.toBeInstanceOf(RegistrationError);

    expect(enqueueRegistrationConfirmed).not.toHaveBeenCalled();
  });

  it("returns the registration even when enqueue throws (fire-and-forget)", async () => {
    enqueueRegistrationConfirmed.mockRejectedValue(new Error("redis_down"));
    const db = makeDb(
      [
        [{ id: "comp_1", status: "published", mode: "individual", registrationEndAt: FUTURE }],
        [],
        [{ id: "comp_1", status: "published", mode: "individual", registrationEndAt: FUTURE }],
      ],
      { insertReturn: [confirmedReg] },
    );
    mockGetDb.mockReturnValue(db);

    // Should NOT throw — enqueue failure is swallowed
    const result = await createIndividualRegistration("stud_1", "comp_1", db as never, NOW);
    // Wait for the microtask queue to flush the .catch() handler
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.id).toBe("reg_1");
  });
});

describe("cancelRegistration — notification enqueue", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("calls enqueueRegistrationCancelled once on successful cancellation", async () => {
    enqueueRegistrationCancelled.mockResolvedValue({});
    const cancelledReg = { ...confirmedReg, status: "cancelled" as const };
    const db = makeDb(
      [
        [confirmedReg],
        [
          {
            id: "comp_1",
            status: "published",
            mode: "individual",
            registrationEndAt: FUTURE,
            eventStartAt: FUTURE,
            allowCancellation: true,
            cancellationCutoffDays: 0,
            feeAmount: null,
          },
        ],
        [
          {
            id: "comp_1",
            status: "published",
            mode: "individual",
            registrationEndAt: FUTURE,
            eventStartAt: FUTURE,
            participantConfirmationAt: null,
            cancelledAt: null,
            allowCancellation: true,
            cancellationCutoffDays: 0,
            feeAmount: null,
          },
        ],
      ],
      { updateReturn: [cancelledReg] },
    );
    mockGetDb.mockReturnValue(db);

    await cancelRegistration("stud_1", "comp_1", "reg_1", "ganti rencana", db as never, NOW);

    expect(enqueueRegistrationCancelled).toHaveBeenCalledOnce();
    expect(enqueueRegistrationCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: "reg_1", registrationType: "individual" }),
    );
  });

  it("does NOT call enqueueRegistrationCancelled when registration not found", async () => {
    const db = makeDb([[]]); // no registration row
    mockGetDb.mockReturnValue(db);

    await expect(
      cancelRegistration("stud_1", "comp_1", "reg_1", null, db as never, NOW),
    ).rejects.toBeInstanceOf(RegistrationError);

    expect(enqueueRegistrationCancelled).not.toHaveBeenCalled();
  });

  it("returns the cancelled registration even when enqueue throws", async () => {
    enqueueRegistrationCancelled.mockRejectedValue(new Error("redis_down"));
    const cancelledReg = { ...confirmedReg, status: "cancelled" as const };
    const db = makeDb(
      [
        [confirmedReg],
        [
          {
            id: "comp_1",
            status: "published",
            mode: "individual",
            registrationEndAt: FUTURE,
            eventStartAt: FUTURE,
            allowCancellation: true,
            cancellationCutoffDays: 0,
            feeAmount: null,
          },
        ],
        [
          {
            id: "comp_1",
            status: "published",
            mode: "individual",
            registrationEndAt: FUTURE,
            eventStartAt: FUTURE,
            participantConfirmationAt: null,
            cancelledAt: null,
            allowCancellation: true,
            cancellationCutoffDays: 0,
            feeAmount: null,
          },
        ],
      ],
      { updateReturn: [cancelledReg] },
    );
    mockGetDb.mockReturnValue(db);

    const result = await cancelRegistration(
      "stud_1",
      "comp_1",
      "reg_1",
      "ganti rencana",
      db as never,
      NOW,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.status).toBe("cancelled");
  });
});
