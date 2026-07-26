// @vitest-environment node
//
// Step 6.3 — 6.1-D4: Worker process*Job unit tests.
// Covers: happy-path dispatch, null guard (missing DB row → clean exit, no throw),
// result-status guard (result-published skips delivery for non-confirmed registrations),
// and partial-failure behavior (all fail → re-throw; some fail → warn, no re-throw).

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const {
  mockGetDb,
  mockSendRegistrationConfirmedEmail,
  mockSendRegistrationCancelledEmail,
  mockSendSubmissionFinalizedEmail,
  mockSendResultPublishedEmail,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockSendRegistrationConfirmedEmail: vi.fn(),
  mockSendRegistrationCancelledEmail: vi.fn(),
  mockSendSubmissionFinalizedEmail: vi.fn(),
  mockSendResultPublishedEmail: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/notifications/notification-email", () => ({
  sendRegistrationConfirmedEmail: mockSendRegistrationConfirmedEmail,
  sendRegistrationCancelledEmail: mockSendRegistrationCancelledEmail,
  sendSubmissionFinalizedEmail: mockSendSubmissionFinalizedEmail,
  sendResultPublishedEmail: mockSendResultPublishedEmail,
}));

import {
  processRegistrationConfirmedJob,
  type RegistrationConfirmedJob,
} from "./registration-confirmed";
import {
  processRegistrationCancelledJob,
  type RegistrationCancelledJob,
} from "./registration-cancelled";
import { processSubmissionFinalizedJob, type SubmissionFinalizedJob } from "./submission-finalized";
import { processResultPublishedJob, type ResultPublishedJob } from "./result-published";

// ── DB mock helper ────────────────────────────────────────────────────────────

function makeSelectMock(results: (unknown[] | null)[]) {
  const queue = [...results];
  const next = () => (queue.length > 0 ? (queue.shift() ?? []) : []);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    limit: () => Promise.resolve(next()),
  };
  return {
    select: vi.fn(() => chain),
  };
}

// ── Job stub helpers ──────────────────────────────────────────────────────────

const makeConfirmedJob = (
  overrides: Partial<RegistrationConfirmedJob["data"]> = {},
): RegistrationConfirmedJob =>
  ({
    id: "job_1",
    data: {
      registrationId: "reg_1",
      studentId: "stud_1",
      competitionId: "comp_1",
      registrationType: "individual",
      ...overrides,
    },
  }) as unknown as RegistrationConfirmedJob;

const makeCancelledJob = (
  overrides: Partial<RegistrationCancelledJob["data"]> = {},
): RegistrationCancelledJob =>
  ({
    id: "job_2",
    data: {
      registrationId: "reg_1",
      studentId: "stud_1",
      competitionId: "comp_1",
      registrationType: "individual",
      ...overrides,
    },
  }) as unknown as RegistrationCancelledJob;

const makeFinalizedJob = (
  overrides: Partial<SubmissionFinalizedJob["data"]> = {},
): SubmissionFinalizedJob =>
  ({
    id: "job_3",
    data: {
      submissionId: "sub_1",
      registrationId: "reg_1",
      studentId: "stud_1",
      competitionId: "comp_1",
      ...overrides,
    },
  }) as unknown as SubmissionFinalizedJob;

const makeResultJob = (overrides: Partial<ResultPublishedJob["data"]> = {}): ResultPublishedJob =>
  ({
    id: "job_4",
    data: {
      registrationId: "reg_1",
      competitionId: "comp_1",
      ...overrides,
    },
  }) as unknown as ResultPublishedJob;

const USER_ROW = { email: "user@test.com", displayName: "Andi" };
const COMP_ROW = { title: "Hackathon 2026" };
const REG_ROW = { registeredAt: new Date("2026-01-01T00:00:00.000Z") };
const SUB_ROW = { finalizedAt: new Date("2026-02-01T00:00:00.000Z") };
const RESULT_ROW = { id: "res_1" };
const RECIPIENT_ROW = {
  userId: "stud_1",
  email: "user@test.com",
  displayName: "Andi",
};

// ── processRegistrationConfirmedJob ──────────────────────────────────────────

describe("processRegistrationConfirmedJob", () => {
  afterEach(() => vi.clearAllMocks());

  it("dispatches email on the happy path", async () => {
    mockGetDb.mockReturnValue(makeSelectMock([[USER_ROW], [COMP_ROW], [REG_ROW]]));
    mockSendRegistrationConfirmedEmail.mockResolvedValue(undefined);

    const job = makeConfirmedJob();
    await processRegistrationConfirmedJob(job);

    expect(mockSendRegistrationConfirmedEmail).toHaveBeenCalledOnce();
    expect(mockSendRegistrationConfirmedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "user@test.com", competitionTitle: "Hackathon 2026" }),
    );
  });

  it("exits cleanly (no throw) when the user row does not exist", async () => {
    // null guard: user not found → warn log and return, no email sent
    mockGetDb.mockReturnValue(makeSelectMock([[], [COMP_ROW], []]));

    const job = makeConfirmedJob();
    await expect(processRegistrationConfirmedJob(job)).resolves.toBeUndefined();
    expect(mockSendRegistrationConfirmedEmail).not.toHaveBeenCalled();
  });

  it("exits cleanly (no throw) when the competition row does not exist", async () => {
    mockGetDb.mockReturnValue(makeSelectMock([[USER_ROW], [], []]));

    const job = makeConfirmedJob();
    await expect(processRegistrationConfirmedJob(job)).resolves.toBeUndefined();
    expect(mockSendRegistrationConfirmedEmail).not.toHaveBeenCalled();
  });

  it("re-throws when sendRegistrationConfirmedEmail throws", async () => {
    mockGetDb.mockReturnValue(makeSelectMock([[USER_ROW], [COMP_ROW], [REG_ROW]]));
    mockSendRegistrationConfirmedEmail.mockRejectedValue(new Error("Resend unavailable"));

    const job = makeConfirmedJob();
    await expect(processRegistrationConfirmedJob(job)).rejects.toThrow("Resend unavailable");
  });
});

// ── processRegistrationCancelledJob ──────────────────────────────────────────

describe("processRegistrationCancelledJob", () => {
  afterEach(() => vi.clearAllMocks());

  it("dispatches email on the happy path", async () => {
    mockGetDb.mockReturnValue(makeSelectMock([[USER_ROW], [COMP_ROW]]));
    mockSendRegistrationCancelledEmail.mockResolvedValue(undefined);

    const job = makeCancelledJob();
    await processRegistrationCancelledJob(job);

    expect(mockSendRegistrationCancelledEmail).toHaveBeenCalledOnce();
    expect(mockSendRegistrationCancelledEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "user@test.com", competitionTitle: "Hackathon 2026" }),
    );
  });

  it("exits cleanly (no throw) when the user row does not exist", async () => {
    mockGetDb.mockReturnValue(makeSelectMock([[], [COMP_ROW]]));

    const job = makeCancelledJob();
    await expect(processRegistrationCancelledJob(job)).resolves.toBeUndefined();
    expect(mockSendRegistrationCancelledEmail).not.toHaveBeenCalled();
  });
});

// ── processSubmissionFinalizedJob ─────────────────────────────────────────────

describe("processSubmissionFinalizedJob", () => {
  afterEach(() => vi.clearAllMocks());

  it("dispatches email on the happy path", async () => {
    mockGetDb.mockReturnValue(makeSelectMock([[USER_ROW], [COMP_ROW], [SUB_ROW]]));
    mockSendSubmissionFinalizedEmail.mockResolvedValue(undefined);

    const job = makeFinalizedJob();
    await processSubmissionFinalizedJob(job);

    expect(mockSendSubmissionFinalizedEmail).toHaveBeenCalledOnce();
    expect(mockSendSubmissionFinalizedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "user@test.com", competitionTitle: "Hackathon 2026" }),
    );
  });

  it("exits cleanly (no throw) when the user row does not exist", async () => {
    mockGetDb.mockReturnValue(makeSelectMock([[], [COMP_ROW], []]));

    const job = makeFinalizedJob();
    await expect(processSubmissionFinalizedJob(job)).resolves.toBeUndefined();
    expect(mockSendSubmissionFinalizedEmail).not.toHaveBeenCalled();
  });
});

// ── processResultPublishedJob ──────────────────────────────────────────────────

describe("processResultPublishedJob", () => {
  afterEach(() => vi.clearAllMocks());

  it("dispatches email to the individual recipient on the happy path", async () => {
    // Query sequence: competition → result status check → individual recipient load
    mockGetDb.mockReturnValue(makeSelectMock([[COMP_ROW], [RESULT_ROW], [RECIPIENT_ROW]]));
    mockSendResultPublishedEmail.mockResolvedValue(undefined);

    const job = makeResultJob();
    await processResultPublishedJob(job);

    expect(mockSendResultPublishedEmail).toHaveBeenCalledOnce();
    expect(mockSendResultPublishedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "user@test.com", competitionTitle: "Hackathon 2026" }),
    );
  });

  it("exits cleanly (no throw) when the competition row does not exist (null guard)", async () => {
    mockGetDb.mockReturnValue(makeSelectMock([[], [], []]));

    const job = makeResultJob();
    await expect(processResultPublishedJob(job)).resolves.toBeUndefined();
    expect(mockSendResultPublishedEmail).not.toHaveBeenCalled();
  });

  it("result-status guard: exits cleanly when no published result row exists", async () => {
    // competition found but result row is missing (e.g., already unpublished)
    mockGetDb.mockReturnValue(makeSelectMock([[COMP_ROW], [], []]));

    const job = makeResultJob();
    await expect(processResultPublishedJob(job)).resolves.toBeUndefined();
    expect(mockSendResultPublishedEmail).not.toHaveBeenCalled();
  });

  it("partial-failure: all recipients fail → re-throws to trigger BullMQ retry", async () => {
    mockGetDb.mockReturnValue(makeSelectMock([[COMP_ROW], [RESULT_ROW], [RECIPIENT_ROW]]));
    mockSendResultPublishedEmail.mockRejectedValue(new Error("Resend unavailable"));

    const job = makeResultJob();
    await expect(processResultPublishedJob(job)).rejects.toThrow(
      "All 1 result.published email(s) failed",
    );
  });

  it("partial-failure: some recipients fail → logs but does not re-throw", async () => {
    const recipient1 = { userId: "u_1", email: "a@test.com", displayName: "A" };
    const recipient2 = { userId: "u_2", email: "b@test.com", displayName: "B" };

    // Build a mock that returns two team recipients from the loadRecipients query.
    // Query sequence: competition → result status check → recipients list (team path)
    const queue: unknown[][] = [[COMP_ROW], [RESULT_ROW], [recipient1, recipient2]];
    const makeChain = () => {
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        limit: () => Promise.resolve(queue.shift() ?? []),
        then: (resolve: (v: unknown) => void) => Promise.resolve(queue.shift() ?? []).then(resolve),
      };
      return chain;
    };
    mockGetDb.mockReturnValue({ select: vi.fn(() => makeChain()) });

    // First recipient succeeds, second fails.
    mockSendResultPublishedEmail
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Resend unavailable"));

    const job = makeResultJob({ teamId: "team_1" });
    await expect(processResultPublishedJob(job)).resolves.toBeUndefined();
    expect(mockSendResultPublishedEmail).toHaveBeenCalledTimes(2);
  });
});
