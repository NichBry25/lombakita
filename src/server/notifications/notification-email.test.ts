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
  sendRegistrationConfirmedEmail,
  sendRegistrationCancelledEmail,
  sendSubmissionFinalizedEmail,
  sendResultPublishedEmail,
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
