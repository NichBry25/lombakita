// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockWriteNotification, mockSendRecruiterVerificationApprovedEmail } = vi.hoisted(
  () => ({
    mockGetDb: vi.fn(),
    mockWriteNotification: vi.fn(),
    mockSendRecruiterVerificationApprovedEmail: vi.fn(),
  }),
);

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/notifications/notification-service", () => ({
  writeNotification: mockWriteNotification,
}));
vi.mock("@/server/notifications/notification-email", () => ({
  sendRecruiterVerificationApprovedEmail: mockSendRecruiterVerificationApprovedEmail,
}));

import { makeSequencedSelect } from "@/server/testing/operator-writer-stubs";
import {
  processRecruiterVerificationApprovedJob,
  type RecruiterVerificationApprovedJob,
} from "./recruiter-verification-approved";

const USER_ROW = { email: "host@seed.lombakita.local" };
const DRAFT_ROW = { title: "Lomba Esai", slug: "lomba-esai", institutionSlug: "budi" };

const approvedJob = (): RecruiterVerificationApprovedJob =>
  ({
    id: "job_a",
    data: { userId: "u_1", epoch: 1_700_000_000_000 },
  }) as unknown as RecruiterVerificationApprovedJob;

describe("processRecruiterVerificationApprovedJob", () => {
  afterEach(() => vi.clearAllMocks());

  it("writes the inbox notice and emails a link to the newest draft", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW], [DRAFT_ROW]]) });
    mockSendRecruiterVerificationApprovedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processRecruiterVerificationApprovedJob(approvedJob());

    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_1",
      "recruiter_verification_approved",
      "Anda kini penyelenggara terverifikasi",
      expect.stringContaining("Lomba Esai"),
    );
    expect(mockSendRecruiterVerificationApprovedEmail).toHaveBeenCalledWith({
      toEmail: "host@seed.lombakita.local",
      recipientId: "u_1",
      draft: { title: "Lomba Esai", path: "/institution/budi/competitions/lomba-esai" },
    });
  });

  it("points to the dashboard when the host has no draft", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW], []]) });
    mockSendRecruiterVerificationApprovedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processRecruiterVerificationApprovedJob(approvedJob());

    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_1",
      "recruiter_verification_approved",
      "Anda kini penyelenggara terverifikasi",
      "Anda sekarang dapat menerbitkan kompetisi dari dasbor penyelenggara.",
    );
    expect(mockSendRecruiterVerificationApprovedEmail).toHaveBeenCalledWith({
      toEmail: "host@seed.lombakita.local",
      recipientId: "u_1",
      draft: null,
    });
  });

  it("warns and stops when the account is gone", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[]]) });

    await processRecruiterVerificationApprovedJob(approvedJob());

    expect(mockWriteNotification).not.toHaveBeenCalled();
    expect(mockSendRecruiterVerificationApprovedEmail).not.toHaveBeenCalled();
  });

  it("rethrows when the email fails, after the inbox row was written", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW], [DRAFT_ROW]]) });
    mockWriteNotification.mockResolvedValue(undefined);
    mockSendRecruiterVerificationApprovedEmail.mockRejectedValueOnce(new Error("smtp down"));

    await expect(processRecruiterVerificationApprovedJob(approvedJob())).rejects.toThrow(
      "smtp down",
    );

    expect(mockWriteNotification).toHaveBeenCalledOnce();
  });

  it("does not rethrow when the inbox write fails, and still sends the email", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW], [DRAFT_ROW]]) });
    mockWriteNotification.mockRejectedValueOnce(new Error("notifications table gone"));
    mockSendRecruiterVerificationApprovedEmail.mockResolvedValue(undefined);

    await expect(processRecruiterVerificationApprovedJob(approvedJob())).resolves.toBeUndefined();

    expect(mockWriteNotification).toHaveBeenCalledOnce();
    expect(mockSendRecruiterVerificationApprovedEmail).toHaveBeenCalledOnce();
  });
});
