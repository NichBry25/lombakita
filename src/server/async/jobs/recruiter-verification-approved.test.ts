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

import {
  processRecruiterVerificationApprovedJob,
  type RecruiterVerificationApprovedJob,
} from "./recruiter-verification-approved";

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

const USER_ROW = { email: "host@test.com" };
const DRAFT_ROW = { title: "Lomba Esai", slug: "lomba-esai", institutionSlug: "budi" };

const approvedJob = (): RecruiterVerificationApprovedJob =>
  ({
    id: "job_a",
    data: { userId: "u_1", epoch: 1_700_000_000_000 },
  }) as unknown as RecruiterVerificationApprovedJob;

describe("processRecruiterVerificationApprovedJob", () => {
  afterEach(() => vi.clearAllMocks());

  it("writes the inbox notice and emails a link to the newest draft", async () => {
    mockGetDb.mockReturnValue(makeDb([[USER_ROW], [DRAFT_ROW]]));
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
      toEmail: "host@test.com",
      recipientId: "u_1",
      draft: { title: "Lomba Esai", path: "/institution/budi/competitions/lomba-esai" },
    });
  });

  it("points to the dashboard when the host has no draft", async () => {
    mockGetDb.mockReturnValue(makeDb([[USER_ROW], []]));
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
      toEmail: "host@test.com",
      recipientId: "u_1",
      draft: null,
    });
  });

  it("warns and stops when the account is gone", async () => {
    mockGetDb.mockReturnValue(makeDb([[]]));

    await processRecruiterVerificationApprovedJob(approvedJob());

    expect(mockWriteNotification).not.toHaveBeenCalled();
    expect(mockSendRecruiterVerificationApprovedEmail).not.toHaveBeenCalled();
  });
});
