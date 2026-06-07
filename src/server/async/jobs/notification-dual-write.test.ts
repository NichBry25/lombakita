// @vitest-environment node
//
// Step 6.5.1 — worker dual-write retrofit tests.
// Verifies: the in-app notification write is invoked after the email block; a DB failure in the
// notification path is swallowed (worker does not rethrow) and the email path is unaffected; the
// new competition.edited fan-out writes one notification per confirmed recipient.

import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDb,
  mockWriteNotification,
  mockSendRegistrationConfirmedEmail,
  mockSendCompetitionEditedEmail,
  mockSendCompetitionCancelledEmail,
  mockSendResultPublishedEmail,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockWriteNotification: vi.fn(),
  mockSendRegistrationConfirmedEmail: vi.fn(),
  mockSendCompetitionEditedEmail: vi.fn(),
  mockSendCompetitionCancelledEmail: vi.fn(),
  mockSendResultPublishedEmail: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
// Only the throwing primitive is mocked — the real `writeInboxNotificationSafely` wrapper runs, so
// its isolated try/catch (the swallow behaviour) is exercised, not stubbed away.
vi.mock("@/server/notifications/notification-service", () => ({
  writeNotification: mockWriteNotification,
}));
vi.mock("@/server/notifications/notification-email", () => ({
  sendRegistrationConfirmedEmail: mockSendRegistrationConfirmedEmail,
  sendCompetitionEditedEmail: mockSendCompetitionEditedEmail,
  sendCompetitionCancelledEmail: mockSendCompetitionCancelledEmail,
  sendResultPublishedEmail: mockSendResultPublishedEmail,
}));

import {
  processRegistrationConfirmedJob,
  type RegistrationConfirmedJob,
} from "./registration-confirmed";
import {
  processCompetitionEditedJob,
  type CompetitionEditedJob,
} from "./competition-edited";
import {
  processCompetitionCancelledJob,
  type CompetitionCancelledJob,
} from "./competition-cancelled";
import { processResultPublishedJob, type ResultPublishedJob } from "./result-published";

// Chain mock — each select() shifts the next canned result; thenable so where-terminated queries
// resolve, and resolves on .limit() too.
function makeDb(queue: unknown[][]) {
  return {
    select: () => {
      const rows = queue.shift() ?? [];
      const chain: Record<string, unknown> = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows),
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  };
}

const USER_ROW = { email: "user@test.com", displayName: "Andi" };
const COMP_ROW = { title: "Hackathon 2026" };
const REG_ROW = { registeredAt: new Date("2026-01-01T00:00:00.000Z") };

const confirmedJob = (): RegistrationConfirmedJob =>
  ({
    id: "job_1",
    data: {
      registrationId: "reg_1",
      studentId: "stud_1",
      competitionId: "comp_1",
      registrationType: "individual",
    },
  }) as unknown as RegistrationConfirmedJob;

const editedJob = (changedFields: string[] = ["eventStartAt"]): CompetitionEditedJob =>
  ({
    id: "job_e",
    data: { competitionId: "comp_1", changedFields, epoch: 1_700_000_000_000 },
  }) as unknown as CompetitionEditedJob;

const cancelledJob = (): CompetitionCancelledJob =>
  ({
    id: "job_c",
    data: { competitionId: "comp_1", epoch: 1_700_000_000_000 },
  }) as unknown as CompetitionCancelledJob;

const resultJob = (): ResultPublishedJob =>
  ({
    id: "job_r",
    data: { registrationId: "reg_1", competitionId: "comp_1", teamId: "team_1" },
  }) as unknown as ResultPublishedJob;

describe("registration-confirmed dual-write", () => {
  afterEach(() => vi.clearAllMocks());

  it("writes an in-app notification after the email dispatch", async () => {
    mockGetDb.mockReturnValue(makeDb([[USER_ROW], [COMP_ROW], [REG_ROW]]));
    mockSendRegistrationConfirmedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processRegistrationConfirmedJob(confirmedJob());

    expect(mockSendRegistrationConfirmedEmail).toHaveBeenCalledOnce();
    expect(mockWriteNotification).toHaveBeenCalledOnce();
    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "stud_1",
      "registration_confirmed",
      "Pendaftaran Dikonfirmasi",
      expect.stringContaining("Hackathon 2026"),
    );
  });

  it("does not rethrow when the notification DB write fails — email path is unaffected", async () => {
    mockGetDb.mockReturnValue(makeDb([[USER_ROW], [COMP_ROW], [REG_ROW]]));
    mockSendRegistrationConfirmedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockRejectedValue(new Error("notifications table gone"));

    await expect(processRegistrationConfirmedJob(confirmedJob())).resolves.toBeUndefined();

    expect(mockSendRegistrationConfirmedEmail).toHaveBeenCalledOnce();
    expect(mockWriteNotification).toHaveBeenCalledOnce();
  });
});

describe("competition-edited fan-out", () => {
  afterEach(() => vi.clearAllMocks());

  it("writes one notification per confirmed recipient", async () => {
    const recipients = [
      { userId: "u_1", email: "a@test.com" },
      { userId: "u_2", email: "b@test.com" },
    ];
    mockGetDb.mockReturnValue(makeDb([[COMP_ROW], recipients]));
    mockSendCompetitionEditedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processCompetitionEditedJob(editedJob());

    expect(mockWriteNotification).toHaveBeenCalledTimes(2);
    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_1",
      "competition_edited",
      "Kompetisi Diperbarui",
      expect.stringContaining("Hackathon 2026"),
    );
    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_2",
      "competition_edited",
      "Kompetisi Diperbarui",
      expect.stringContaining("Hackathon 2026"),
    );
  });

  it("summarizes the changed fields into a broad category in the notification body", async () => {
    mockGetDb.mockReturnValue(
      makeDb([[COMP_ROW], [{ userId: "u_1", email: "a@test.com" }]]),
    );
    mockSendCompetitionEditedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processCompetitionEditedJob(editedJob(["eventStartAt", "registrationEndAt"]));

    // "jadwal" is the schedule category; old/new values are never leaked.
    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_1",
      "competition_edited",
      "Kompetisi Diperbarui",
      expect.stringContaining("jadwal"),
    );
    expect(mockSendCompetitionEditedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ changeCategories: ["jadwal"] }),
    );
  });

  it("does not rethrow when the notification write fails but the email succeeds", async () => {
    mockGetDb.mockReturnValue(
      makeDb([[COMP_ROW], [{ userId: "u_1", email: "a@test.com" }]]),
    );
    mockWriteNotification.mockRejectedValue(new Error("notifications table gone"));
    mockSendCompetitionEditedEmail.mockResolvedValue(undefined);

    await expect(processCompetitionEditedJob(editedJob())).resolves.toBeUndefined();
    expect(mockSendCompetitionEditedEmail).toHaveBeenCalledOnce();
  });
});

describe("competition-cancelled fan-out", () => {
  afterEach(() => vi.clearAllMocks());

  it("writes one notification per institution-cancelled recipient", async () => {
    const recipients = [
      { userId: "u_1", email: "a@test.com" },
      { userId: "u_2", email: "b@test.com" },
    ];
    mockGetDb.mockReturnValue(makeDb([[COMP_ROW], recipients]));
    mockSendCompetitionCancelledEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processCompetitionCancelledJob(cancelledJob());

    expect(mockWriteNotification).toHaveBeenCalledTimes(2);
    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_1",
      "competition_cancelled",
      "Kompetisi Dibatalkan",
      expect.stringContaining("Hackathon 2026"),
    );
  });

  it("does not rethrow when the notification write fails but the email succeeds", async () => {
    mockGetDb.mockReturnValue(
      makeDb([[COMP_ROW], [{ userId: "u_1", email: "a@test.com" }]]),
    );
    mockWriteNotification.mockRejectedValue(new Error("notifications table gone"));
    mockSendCompetitionCancelledEmail.mockResolvedValue(undefined);

    await expect(processCompetitionCancelledJob(cancelledJob())).resolves.toBeUndefined();
    expect(mockSendCompetitionCancelledEmail).toHaveBeenCalledOnce();
  });
});

// 6.5.1-T1 — result-published is the most intricate dual-write path: a fan-out loop where the
// notification write must be isolated from the email `errors[]` accounting that drives the
// all-recipients-failed BullMQ retry decision.
describe("result-published dual-write isolation", () => {
  afterEach(() => vi.clearAllMocks());

  const RESULT_ROW = { id: "res_1" };
  const recipients = [
    { userId: "u_1", email: "a@test.com", displayName: "A" },
    { userId: "u_2", email: "b@test.com", displayName: "B" },
  ];

  it("writes one notification per recipient and does NOT rethrow when the notification write fails but emails succeed", async () => {
    // Query sequence: competition → published-result guard → team recipients.
    mockGetDb.mockReturnValue(makeDb([[COMP_ROW], [RESULT_ROW], recipients]));
    mockSendResultPublishedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockRejectedValue(new Error("notifications table gone"));

    await expect(processResultPublishedJob(resultJob())).resolves.toBeUndefined();

    expect(mockWriteNotification).toHaveBeenCalledTimes(2);
    expect(mockSendResultPublishedEmail).toHaveBeenCalledTimes(2);
  });

  it("still rethrows when ALL emails fail, even though notifications were written first", async () => {
    mockGetDb.mockReturnValue(makeDb([[COMP_ROW], [RESULT_ROW], recipients]));
    mockWriteNotification.mockResolvedValue(undefined);
    mockSendResultPublishedEmail.mockRejectedValue(new Error("Resend unavailable"));

    await expect(processResultPublishedJob(resultJob())).rejects.toThrow(
      "All 2 result.published email(s) failed",
    );

    // Notification rows are written for every recipient regardless of the email retry decision.
    expect(mockWriteNotification).toHaveBeenCalledTimes(2);
  });
});
