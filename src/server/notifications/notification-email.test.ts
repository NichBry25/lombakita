// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverEnv, sendEmailMock } = vi.hoisted(() => ({
  serverEnv: {
    resendApiKey: "re_test_key",
    authEmailFrom: "noreply@lombakita.id",
    authUrl: "https://lombakita.id",
    appBaseUrl: undefined as string | undefined,
    emailDeliveryEnabled: true,
    appEnv: "test",
  },
  sendEmailMock: vi.fn(),
}));

vi.mock("@/config/env.server", () => ({ serverEnv }));
vi.mock("@/config/env", () => ({ publicEnv: { appUrl: "https://lombakita.id" } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: sendEmailMock },
  })),
}));

import {
  sendCompetitionCancelledEmail,
  sendRegistrationConfirmedEmail,
  sendRegistrationCancelledEmail,
  sendSubmissionFinalizedEmail,
  sendResultPublishedEmail,
  sendPaymentProofSubmittedEmail,
  sendPaymentOutcomeEmail,
} from "@/server/notifications/notification-email";

describe("sendRegistrationConfirmedEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
  });

  it("sends email to correct recipient with competition title in subject", async () => {
    await sendRegistrationConfirmedEmail({
      toEmail: "candidate@example.com",
      recipientId: "user_1",
      competitionTitle: "Lomba Teknologi 2026",
      registrationType: "individual",
      registeredAt: new Date("2026-06-01T10:00:00Z"),
    });

    expect(sendEmailMock).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.to).toBe("candidate@example.com");
    expect(call.from).toBe("noreply@lombakita.id");
    expect(call.subject).toContain("Lomba Teknologi 2026");
    expect(call.subject).toContain("Pendaftaran kamu berhasil");
    expect(call.text).toContain("Individu");
  });

  it("includes team type label for team registration", async () => {
    await sendRegistrationConfirmedEmail({
      toEmail: "captain@example.com",
      recipientId: "user_2",
      competitionTitle: "Kompetisi Tim 2026",
      registrationType: "team",
      registeredAt: new Date("2026-06-01T10:00:00Z"),
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.text).toContain("Tim");
  });

  it("throws on Resend error", async () => {
    sendEmailMock.mockResolvedValue({ data: null, error: { message: "rate_limit" } });

    await expect(
      sendRegistrationConfirmedEmail({
        toEmail: "candidate@example.com",
        recipientId: "user_1",
        competitionTitle: "Lomba X",
        registrationType: "individual",
        registeredAt: new Date(),
      }),
    ).rejects.toThrow("rate_limit");
  });

  it("throws when Resend is not configured", async () => {
    serverEnv.resendApiKey = undefined as unknown as string;

    await expect(
      sendRegistrationConfirmedEmail({
        toEmail: "candidate@example.com",
        recipientId: "user_1",
        competitionTitle: "Lomba X",
        registrationType: "individual",
        registeredAt: new Date(),
      }),
    ).rejects.toThrow("not fully configured");

    serverEnv.resendApiKey = "re_test_key";
  });
});

describe("sendRegistrationCancelledEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ data: { id: "email_2" }, error: null });
  });

  it("sends email with cancellation subject containing competition title", async () => {
    await sendRegistrationCancelledEmail({
      toEmail: "candidate@example.com",
      recipientId: "user_1",
      competitionTitle: "Lomba Sains 2026",
      registrationType: "individual",
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.to).toBe("candidate@example.com");
    expect(call.subject).toContain("Lomba Sains 2026");
    expect(call.subject).toContain("dibatalkan");
  });
});

describe("sendSubmissionFinalizedEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ data: { id: "email_3" }, error: null });
  });

  it("sends email with finalized subject and finalization timestamp in body", async () => {
    await sendSubmissionFinalizedEmail({
      toEmail: "candidate@example.com",
      recipientId: "user_1",
      competitionTitle: "Hackathon 2026",
      finalizedAt: new Date("2026-06-10T14:30:00Z"),
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.to).toBe("candidate@example.com");
    expect(call.subject).toContain("Hackathon 2026");
    expect(call.subject).toContain("dikunci");
    expect(call.text).toContain("Hackathon 2026");
  });
});

describe("sendResultPublishedEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ data: { id: "email_4" }, error: null });
  });

  it("personalizes greeting with displayName when provided", async () => {
    await sendResultPublishedEmail({
      toEmail: "candidate@example.com",
      recipientId: "user_1",
      displayName: "Budi Santoso",
      competitionTitle: "Lomba Desain 2026",
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.text).toContain("Hai Budi Santoso");
    expect(call.subject).toContain("Lomba Desain 2026");
    expect(call.subject).toContain("diumumkan");
  });

  it("uses fallback greeting when displayName is null", async () => {
    await sendResultPublishedEmail({
      toEmail: "candidate@example.com",
      recipientId: "user_1",
      displayName: null,
      competitionTitle: "Lomba Desain 2026",
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.text).toContain("Hai,");
  });
});

describe("sendPaymentProofSubmittedEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
  });

  it("links to the review queue itself, not to a chooser", async () => {
    await sendPaymentProofSubmittedEmail({
      toEmail: "owner@example.com",
      recipientId: "user_1",
      competitionTitle: "Seed Coding League",
      institutionSlug: "seed-academy",
      competitionSlug: "seed-coding-league",
      payerDisplayName: "Sari Melati",
      amount: "Rp 150.000",
    });

    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.subject).toBe("Bukti transfer baru untuk Seed Coding League");
    expect(call.text).toContain("Sari Melati");
    expect(call.text).toContain("Rp 150.000");
    // An organiser who administers two institutions cannot act on a link to /institution.
    expect(call.text).toContain(
      "https://lombakita.id/institution/seed-academy/competitions/seed-coding-league/payments",
    );
  });

  it("repeats that the money never reached Lombakita", async () => {
    await sendPaymentProofSubmittedEmail({
      toEmail: "owner@example.com",
      recipientId: "user_1",
      competitionTitle: "Seed Coding League",
      institutionSlug: "seed-academy",
      competitionSlug: "seed-coding-league",
      payerDisplayName: "Sari Melati",
      amount: "Rp 150.000",
    });

    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    // The platform cannot confirm this transfer arrived. Only the organiser's own bank statement
    // can, so the instruction to check it travels with every notice that invites a verdict.
    expect(call.text).toContain("mutasi rekening");
    expect(call.text).toContain("bukan ke Lombakita");
  });
});

describe("sendPaymentOutcomeEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
  });

  const send = (
    outcome: "verified" | "rejected" | "expired" | "voided",
    extra: { rejectionReason?: string | null; resubmissionAllowed?: boolean | null } = {},
  ) =>
    sendPaymentOutcomeEmail({
      toEmail: "payer@example.com",
      recipientId: "user_1",
      competitionTitle: "Seed Coding League",
      outcome,
      rejectionReason: extra.rejectionReason ?? null,
      resubmissionAllowed: extra.resubmissionAllowed ?? null,
      amount: "Rp 150.000",
    });

  it("confirms a verified payment and asks for nothing further", async () => {
    await send("verified");

    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.subject).toBe("Pembayaran diverifikasi untuk Seed Coding League");
    expect(call.text).toContain("Rp 150.000");
    expect(call.text).toContain("Tidak ada tindakan lain yang diperlukan.");
  });

  it("carries the organiser's reason on a rejection", async () => {
    await send("rejected", { rejectionReason: "Nominal tidak sesuai", resubmissionAllowed: true });

    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.subject).toBe("Bukti transfer ditolak untuk Seed Coding League");
    expect(call.text).toContain("Alasan: Nominal tidak sesuai");
    expect(call.text).toContain("Unggah bukti transfer yang baru");
  });

  it("warns a barred payer about the deadline instead of inviting a resubmission", async () => {
    await send("rejected", {
      rejectionReason: "Bukan transfer ke rekening kami",
      resubmissionAllowed: false,
    });

    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.text).toContain("Anda tidak dapat mengirim bukti baru.");
    expect(call.text).toContain("sebelum batas waktu");
    expect(call.text).not.toContain("Unggah bukti transfer yang baru");
  });

  it("attributes a void to Lombakita, and offers the resend unconditionally", async () => {
    await send("voided", { rejectionReason: "Bukti milik peserta lain" });

    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.subject).toBe("Bukti transfer dibatalkan untuk Seed Coding League");
    expect(call.text).toContain("Tim Lombakita membatalkan");
    expect(call.text).toContain("bukan keputusan penyelenggara");
    expect(call.text).toContain("Alasan: Bukti milik peserta lain");
    expect(call.text).toContain("Anda dapat mengirim bukti transfer baru");
  });

  it("blames the deadline for an expiry, and nobody else", async () => {
    await send("expired");

    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.subject).toBe("Pendaftaran dibatalkan otomatis untuk Seed Coding League");
    expect(call.text).toContain("secara otomatis");
    expect(call.text).toContain("tidak dilakukan oleh penyelenggara");
    // No amount either: an expiry is not a statement about money that moved.
    expect(call.text).not.toContain("ditolak");
  });
});

describe("sendCompetitionCancelledEmail: the refund sentence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
  });

  it("tells a payer where their money actually is", async () => {
    await sendCompetitionCancelledEmail({
      toEmail: "payer@example.com",
      recipientId: "user_1",
      competitionTitle: "Seed Coding League",
      transferRefundNotice: true,
    });

    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    // DEC-0130: the funds are in the organiser's account and always were. Naming the holder is the
    // only useful thing this notice can do.
    expect(call.text).toContain("rekening penyelenggara");
    expect(call.text).toContain("Lombakita tidak menampung dana peserta");
    // And no promise the platform cannot keep.
    expect(call.text).not.toContain("akan kami kembalikan");
    expect(call.text).not.toContain("pengembalian dana otomatis");
  });

  it("says nothing about refunds to somebody who never paid", async () => {
    // Paired with the case above. A free registrant told to chase a refund is being invented a
    // transfer they never made.
    await sendCompetitionCancelledEmail({
      toEmail: "free@example.com",
      recipientId: "user_2",
      competitionTitle: "Seed Coding League",
    });

    const call = sendEmailMock.mock.calls[0]![0] as Record<string, string>;
    expect(call.text).not.toContain("rekening penyelenggara");
  });
});
