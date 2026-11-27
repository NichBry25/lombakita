// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockWriteNotification, mockSendHostTrustRemovedEmail } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockWriteNotification: vi.fn(),
  mockSendHostTrustRemovedEmail: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/notifications/notification-service", () => ({
  writeNotification: mockWriteNotification,
}));
vi.mock("@/server/notifications/notification-email", () => ({
  sendHostTrustRemovedEmail: mockSendHostTrustRemovedEmail,
}));

import { makeSequencedSelect } from "@/server/testing/operator-writer-stubs";
import { processHostTrustRemovedJob, type HostTrustRemovedJob } from "./host-trust-removed";

const USER_ROW = { email: "host@seed.lombakita.local" };

const REASON = "Kontak palsu di beberapa kompetisi.";
const REMOVED_TITLE = "Status tepercaya Anda dicabut";
const REMOVED_BODY = `Alasan: ${REASON} Kompetisi yang sudah tayang tetap tayang. Kompetisi berikutnya diperiksa staf sebelum tayang.`;

const removedJob = (data: Record<string, unknown>): HostTrustRemovedJob =>
  ({ id: "job_t", data }) as unknown as HostTrustRemovedJob;

describe("processHostTrustRemovedJob", () => {
  afterEach(() => vi.clearAllMocks());

  it("writes the trust removal notice with the reason and emails the same words", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW]]) });
    mockSendHostTrustRemovedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processHostTrustRemovedJob(removedJob({ userId: "u_1", reason: REASON, epoch: 1 }));

    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_1",
      "host_trust_removed",
      REMOVED_TITLE,
      REMOVED_BODY,
    );
    expect(mockSendHostTrustRemovedEmail).toHaveBeenCalledWith({
      toEmail: "host@seed.lombakita.local",
      recipientId: "u_1",
      title: REMOVED_TITLE,
      body: REMOVED_BODY,
    });
  });

  it("ends a reason that has no full stop with one, before the next sentence", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW]]) });
    mockSendHostTrustRemovedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processHostTrustRemovedJob(
      removedJob({ userId: "u_1", reason: "Kontak palsu", epoch: 1 }),
    );

    const body =
      "Alasan: Kontak palsu. Kompetisi yang sudah tayang tetap tayang. Kompetisi berikutnya diperiksa staf sebelum tayang.";
    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_1",
      "host_trust_removed",
      REMOVED_TITLE,
      body,
    );
    expect(mockSendHostTrustRemovedEmail).toHaveBeenCalledWith(expect.objectContaining({ body }));
  });

  it("rethrows when the email fails, after the inbox row was written", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW]]) });
    mockSendHostTrustRemovedEmail.mockRejectedValueOnce(new Error("smtp down"));
    mockWriteNotification.mockResolvedValue(undefined);

    await expect(
      processHostTrustRemovedJob(removedJob({ userId: "u_1", reason: REASON, epoch: 1 })),
    ).rejects.toThrow("smtp down");

    expect(mockWriteNotification).toHaveBeenCalledOnce();
  });

  it("writes and sends nothing for an account that no longer exists", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[]]) });

    await processHostTrustRemovedJob(removedJob({ userId: "u_1", reason: REASON, epoch: 1 }));

    expect(mockWriteNotification).not.toHaveBeenCalled();
    expect(mockSendHostTrustRemovedEmail).not.toHaveBeenCalled();
  });
});
