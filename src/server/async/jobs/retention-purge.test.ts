// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockIsR2Available,
  mockListSubmissionsDue,
  mockPurgeSubmissions,
  mockListDocumentsDue,
  mockPurgeDocuments,
} = vi.hoisted(() => ({
  mockIsR2Available: vi.fn(),
  mockListSubmissionsDue: vi.fn(),
  mockPurgeSubmissions: vi.fn(),
  mockListDocumentsDue: vi.fn(),
  mockPurgeDocuments: vi.fn(),
}));

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/server/storage/r2.client", () => ({ isR2Available: mockIsR2Available }));
vi.mock("@/server/submissions/submission-service", () => ({
  listCompetitionsDueForSubmissionPurge: mockListSubmissionsDue,
  purgeUnfinalizedSubmissionsForCompetition: mockPurgeSubmissions,
}));
vi.mock("@/server/registration-documents/registration-document-service", () => ({
  listCompetitionsDueForDocumentPurge: mockListDocumentsDue,
  purgeDocumentsForCompetition: mockPurgeDocuments,
}));

import { processRetentionPurgeJob, type RetentionPurgeJob } from "./retention-purge";

const job = { data: { scheduledFor: "0 3 * * *" } } as RetentionPurgeJob;

beforeEach(() => {
  mockIsR2Available.mockReturnValue(true);
  mockListSubmissionsDue.mockResolvedValue([]);
  mockListDocumentsDue.mockResolvedValue([]);
  mockPurgeSubmissions.mockResolvedValue({});
  mockPurgeDocuments.mockResolvedValue({});
});
afterEach(() => vi.clearAllMocks());

describe("processRetentionPurgeJob", () => {
  it("purges every competition each due-list returns", async () => {
    mockListSubmissionsDue.mockResolvedValue(["comp_1", "comp_2"]);
    mockListDocumentsDue.mockResolvedValue(["comp_3"]);

    await processRetentionPurgeJob(job);

    expect(mockPurgeSubmissions).toHaveBeenCalledTimes(2);
    expect(mockPurgeSubmissions).toHaveBeenCalledWith("comp_1");
    expect(mockPurgeSubmissions).toHaveBeenCalledWith("comp_2");
    expect(mockPurgeDocuments).toHaveBeenCalledExactlyOnceWith("comp_3");
  });

  // The reason the job swallows per-competition errors rather than letting BullMQ retry: a retry
  // would re-walk the competitions that already succeeded.
  it("continues past a competition that fails, and does not rethrow", async () => {
    mockListSubmissionsDue.mockResolvedValue(["bad", "good"]);
    mockPurgeSubmissions.mockRejectedValueOnce(new Error("r2_timeout")).mockResolvedValue({});

    await expect(processRetentionPurgeJob(job)).resolves.toBeUndefined();

    expect(mockPurgeSubmissions).toHaveBeenCalledTimes(2);
    expect(mockPurgeSubmissions).toHaveBeenLastCalledWith("good");
  });

  it("still runs the document sweep when the submission sweep fails outright", async () => {
    mockListSubmissionsDue.mockResolvedValue(["bad"]);
    mockListDocumentsDue.mockResolvedValue(["comp_3"]);
    mockPurgeSubmissions.mockRejectedValue(new Error("r2_timeout"));

    await processRetentionPurgeJob(job);

    expect(mockPurgeDocuments).toHaveBeenCalledExactlyOnceWith("comp_3");
  });

  // Skipping rather than failing: retrying against absent storage would spin the queue, and
  // retention windows are months long, so one missed day costs nothing.
  it("skips entirely when storage is unavailable", async () => {
    mockIsR2Available.mockReturnValue(false);
    mockListSubmissionsDue.mockResolvedValue(["comp_1"]);

    await processRetentionPurgeJob(job);

    expect(mockListSubmissionsDue).not.toHaveBeenCalled();
    expect(mockPurgeSubmissions).not.toHaveBeenCalled();
    expect(mockPurgeDocuments).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing is due", async () => {
    await expect(processRetentionPurgeJob(job)).resolves.toBeUndefined();
    expect(mockPurgeSubmissions).not.toHaveBeenCalled();
    expect(mockPurgeDocuments).not.toHaveBeenCalled();
  });
});
