// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockWriteNotification, mockSendRecruiterVerificationRejectedEmail } = vi.hoisted(
  () => ({
    mockGetDb: vi.fn(),
    mockWriteNotification: vi.fn(),
    mockSendRecruiterVerificationRejectedEmail: vi.fn(),
  }),
);

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/notifications/notification-service", () => ({
  writeNotification: mockWriteNotification,
}));
vi.mock("@/server/notifications/notification-email", () => ({
  sendRecruiterVerificationRejectedEmail: mockSendRecruiterVerificationRejectedEmail,
}));

import { makeSequencedSelect } from "@/server/testing/operator-writer-stubs";
import {
  processRecruiterVerificationRejectedJob,
  type RecruiterVerificationRejectedJob,
} from "./recruiter-verification-rejected";

const USER_ROW = { email: "host@seed.lombakita.local" };

const TURN_DOWN_TITLE = "Kompetisi Anda belum dapat tayang";
const KONTAK_TEXT = "Penyelenggara mencantumkan kontak yang benar-benar bisa dihubungi peserta.";
const NOTE = "Nomor kontak tidak aktif.";
const TURN_DOWN_BODY = `Pedoman: ${KONTAK_TEXT} Catatan staf: ${NOTE} Perbaiki draf lalu tekan Kirim untuk diperiksa lagi.`;

const rejectedJob = (data: Record<string, unknown>): RecruiterVerificationRejectedJob =>
  ({ id: "job_r", data }) as unknown as RecruiterVerificationRejectedJob;

const turnDownData = (guidelineItem: string) => ({
  submissionId: "check_1",
  userId: "u_1",
  rejectionReason: NOTE,
  resubmissionAllowed: false,
  guidelineItem,
  epoch: 1,
});

describe("processRecruiterVerificationRejectedJob", () => {
  afterEach(() => vi.clearAllMocks());

  it("writes the host check turn-down with the guideline sentence and the note, and emails the same words", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW]]) });
    mockSendRecruiterVerificationRejectedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processRecruiterVerificationRejectedJob(rejectedJob(turnDownData("kontak-nyata")));

    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_1",
      "recruiter_verification_rejected",
      TURN_DOWN_TITLE,
      TURN_DOWN_BODY,
    );
    expect(mockSendRecruiterVerificationRejectedEmail).toHaveBeenCalledWith({
      toEmail: "host@seed.lombakita.local",
      recipientId: "u_1",
      rejectionReason: NOTE,
      resubmissionAllowed: false,
      hostCheckTurnDown: { title: TURN_DOWN_TITLE, body: TURN_DOWN_BODY },
    });
  });

  it("keeps the request rejection words when no guideline item is named", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW]]) });
    mockSendRecruiterVerificationRejectedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processRecruiterVerificationRejectedJob(
      rejectedJob({
        submissionId: "sub_1",
        userId: "u_1",
        rejectionReason: "Dokumen tidak jelas",
        resubmissionAllowed: true,
        epoch: 1,
      }),
    );

    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_1",
      "recruiter_verification_rejected",
      "Permohonan penyelenggara terverifikasi ditolak",
      "Alasan: Dokumen tidak jelas Perbarui data dan dokumen Anda, lalu ajukan ulang.",
    );
    expect(mockSendRecruiterVerificationRejectedEmail).toHaveBeenCalledWith({
      toEmail: "host@seed.lombakita.local",
      recipientId: "u_1",
      rejectionReason: "Dokumen tidak jelas",
      resubmissionAllowed: true,
    });
  });

  it("shows an unknown guideline item by its code", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW]]) });
    mockSendRecruiterVerificationRejectedEmail.mockResolvedValue(undefined);
    mockWriteNotification.mockResolvedValue(undefined);

    await processRecruiterVerificationRejectedJob(rejectedJob(turnDownData("bukan-pedoman")));

    expect(mockWriteNotification).toHaveBeenCalledWith(
      expect.anything(),
      "u_1",
      "recruiter_verification_rejected",
      TURN_DOWN_TITLE,
      "Pedoman: bukan-pedoman Catatan staf: Nomor kontak tidak aktif. Perbaiki draf lalu tekan Kirim untuk diperiksa lagi.",
    );
  });

  it("rethrows when the email fails, after the inbox row was written", async () => {
    mockGetDb.mockReturnValue({ select: makeSequencedSelect([[USER_ROW]]) });
    mockWriteNotification.mockResolvedValue(undefined);
    mockSendRecruiterVerificationRejectedEmail.mockRejectedValueOnce(new Error("smtp down"));

    await expect(
      processRecruiterVerificationRejectedJob(rejectedJob(turnDownData("kontak-nyata"))),
    ).rejects.toThrow("smtp down");

    expect(mockWriteNotification).toHaveBeenCalledOnce();
  });
});
