// @vitest-environment node

// A 403 MUST BE DISTINGUISHABLE FROM A TRANSIENT FAILURE, AT THE SEND SITE, NOT ONLY IN THEORY.
//
// The classification is pure and easy to test in isolation, which is exactly why isolation is not
// enough: every send site used to flatten the provider's response into `new Error(message)`, and a
// classifier that is never reached by a real send is a classifier that reports nothing. The wiring
// block at the bottom drives an actual exported send function with a mocked provider, so what is
// asserted is the behaviour of the production path rather than of a hand-built input.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverEnv, sendEmailMock } = vi.hoisted(() => ({
  serverEnv: {
    resendApiKey: "re_test_key",
    authEmailFrom: "noreply@mail.lombakita.com",
    authUrl: "https://lombakita.local",
    appBaseUrl: undefined as string | undefined,
    emailDeliveryEnabled: true,
    appEnv: "test",
  },
  sendEmailMock: vi.fn(),
}));

vi.mock("@/config/env.server", () => ({ serverEnv }));
vi.mock("@/config/env", () => ({ publicEnv: { appUrl: "https://lombakita.local" } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: sendEmailMock },
  })),
}));

import {
  EmailSendError,
  classifyEmailFailure,
  classifyProviderError,
  classifySmtpError,
  describeEmailFailure,
  rethrowSmtpSendFailure,
  throwEmailSendFailure,
} from "@/server/email/send-failure";
import { ReservedRecipientError } from "@/server/email/reserved-recipients";
import { sendRegistrationConfirmedEmail } from "@/server/notifications/notification-email";

describe("classifyProviderError", () => {
  it("reads a 403 as forbidden whatever the provider calls it", () => {
    expect(
      classifyProviderError({ message: "denied", statusCode: 403, name: "application_error" }),
    ).toBe("forbidden");
  });

  it("reads a rejected sending identity as forbidden even without a 403", () => {
    // The production failure: a send-only key asked to send from a domain it is not verified for.
    expect(
      classifyProviderError({ message: "bad from", statusCode: 422, name: "invalid_from_address" }),
    ).toBe("forbidden");
    expect(
      classifyProviderError({
        message: "restricted",
        statusCode: null,
        name: "restricted_api_key",
      }),
    ).toBe("forbidden");
  });

  it("reads a server-side or rate-limit failure as transient", () => {
    expect(
      classifyProviderError({ message: "boom", statusCode: 500, name: "internal_server_error" }),
    ).toBe("transient");
    expect(
      classifyProviderError({ message: "slow down", statusCode: 429, name: "rate_limit_exceeded" }),
    ).toBe("transient");
  });
});

describe("classifySmtpError", () => {
  it("reads a rejected credential as forbidden", () => {
    expect(classifySmtpError({ code: "EAUTH", responseCode: 535 })).toBe("forbidden");
  });

  it("reads any 5xx reply as forbidden, because SMTP defines 5xx as permanent", () => {
    expect(classifySmtpError({ code: "EENVELOPE", responseCode: 550 })).toBe("forbidden");
  });

  it("reads a 4xx reply as transient", () => {
    expect(classifySmtpError({ code: "EENVELOPE", responseCode: 451 })).toBe("transient");
  });

  it("does not crash on an error that carries no SMTP shape at all", () => {
    expect(classifySmtpError(new Error("socket closed"))).toBe("transient");
    expect(classifySmtpError(null)).toBe("transient");
    expect(classifySmtpError("nope")).toBe("transient");
  });
});

describe("classifyEmailFailure", () => {
  it("separates the three classes a caller has to tell apart", () => {
    expect(classifyEmailFailure(new ReservedRecipientError("local", "team_invitation"))).toBe(
      "reserved_recipient",
    );
    expect(
      classifyEmailFailure(
        new EmailSendError({
          kind: "k",
          failureClass: "forbidden",
          providerCode: "invalid_from_address",
          statusCode: 403,
          message: "denied",
        }),
      ),
    ).toBe("forbidden");
    expect(classifyEmailFailure(new Error("connection reset"))).toBe("transient");
  });
});

describe("throwEmailSendFailure", () => {
  it("keeps the status and the provider code reachable on the thrown error", () => {
    let caught: unknown;
    try {
      throwEmailSendFailure("registration_confirmed", {
        message: "not allowed",
        statusCode: 403,
        name: "invalid_from_address",
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EmailSendError);
    const failure = caught as EmailSendError;
    expect(failure.failureClass).toBe("forbidden");
    expect(failure.statusCode).toBe(403);
    expect(failure.providerCode).toBe("invalid_from_address");
    expect(failure.kind).toBe("registration_confirmed");
  });
});

describe("rethrowSmtpSendFailure", () => {
  it("carries the SMTP reply code through as the status", () => {
    let caught: unknown;
    try {
      rethrowSmtpSendFailure(
        "registration_verification",
        Object.assign(new Error("auth failed"), { code: "EAUTH", responseCode: 535 }),
      );
    } catch (error: unknown) {
      caught = error;
    }

    const failure = caught as EmailSendError;
    expect(failure.failureClass).toBe("forbidden");
    expect(failure.statusCode).toBe(535);
    expect(failure.providerCode).toBe("EAUTH");
  });
});

describe("describeEmailFailure", () => {
  it("reports an unrecognised error as transient with no invented provider detail", () => {
    expect(describeEmailFailure(new Error("socket hang up"))).toEqual({
      failureClass: "transient",
      providerCode: null,
      statusCode: null,
      detail: "socket hang up",
    });
  });
});

// Rule 33: the classification is only real if a production send site actually produces it.
describe("a real send site, driven end to end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("raises a forbidden EmailSendError when the provider answers 403", async () => {
    sendEmailMock.mockResolvedValue({
      data: null,
      error: {
        message: "You are not allowed to send from this domain",
        statusCode: 403,
        name: "invalid_from_address",
      },
    });

    const attempt = sendRegistrationConfirmedEmail({
      toEmail: "candidate@example.com",
      recipientId: "user_1",
      competitionTitle: "Lomba Teknologi 2026",
      registrationType: "individual",
      registeredAt: new Date("2026-06-01T10:00:00Z"),
    });

    await expect(attempt).rejects.toBeInstanceOf(EmailSendError);
    await expect(attempt).rejects.toMatchObject({
      failureClass: "forbidden",
      statusCode: 403,
      providerCode: "invalid_from_address",
    });
  });

  it("raises a transient EmailSendError when the provider answers 500", async () => {
    sendEmailMock.mockResolvedValue({
      data: null,
      error: { message: "internal error", statusCode: 500, name: "internal_server_error" },
    });

    await expect(
      sendRegistrationConfirmedEmail({
        toEmail: "candidate@example.com",
        recipientId: "user_1",
        competitionTitle: "Lomba Teknologi 2026",
        registrationType: "individual",
        registeredAt: new Date("2026-06-01T10:00:00Z"),
      }),
    ).rejects.toMatchObject({ failureClass: "transient" });
  });

  it("raises a reserved_recipient failure before the provider is ever called", async () => {
    sendEmailMock.mockResolvedValue({ data: { id: "email_1" }, error: null });

    const attempt = sendRegistrationConfirmedEmail({
      toEmail: "burst@seed.lombakita.local",
      recipientId: "user_1",
      competitionTitle: "Lomba Teknologi 2026",
      registrationType: "individual",
      registeredAt: new Date("2026-06-01T10:00:00Z"),
    });

    await expect(attempt).rejects.toBeInstanceOf(ReservedRecipientError);
    expect(classifyEmailFailure(await attempt.catch((e: unknown) => e))).toBe("reserved_recipient");
    // The point of refusing at the boundary: nothing was handed to the provider.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
