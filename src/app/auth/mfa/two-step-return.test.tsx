// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { getRedirectError } from "next/dist/client/components/redirect";
import MfaChallengePage from "./challenge/page";
import MfaEnrollPage from "./enroll/page";
import { MfaChallengeForm } from "./challenge/mfa-challenge-form";
import { MfaEnrollForm } from "./enroll/mfa-enroll-form";
import { MfaError } from "@/server/auth/mfa/mfa-core";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  start: vi.fn(),
  qr: vi.fn(),
}));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: mocks.session }));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw getRedirectError(path, "replace");
  },
}));
vi.mock("@/components/auth/auth-page-frame", () => ({ AuthPageFrame: () => null }));
vi.mock("./challenge/mfa-challenge-form", () => ({ MfaChallengeForm: () => null }));
vi.mock("./enroll/mfa-enroll-form", () => ({ MfaEnrollForm: () => null }));
vi.mock("@/server/auth/mfa/factor-service", () => ({ startMfaEnrolment: mocks.start }));
vi.mock("@/server/auth/mfa/otpauth-qr", () => ({ renderOtpauthQrDataUrl: mocks.qr }));

type SessionUser = NonNullable<Session["user"]>;

const givenSession = (role: SessionUser["role"], mfaStatus: SessionUser["mfaStatus"]): void => {
  mocks.session.mockResolvedValue({
    user: { id: "user", role, verifiedRoles: [], mfaStatus },
    expires: "2099-01-01T00:00:00.000Z",
  } satisfies Session);
};
const withCallbackUrl = (callbackUrl: string) => ({
  searchParams: Promise.resolve({ callbackUrl }),
});
const redirectDigest = (path: string): string => getRedirectError(path, "replace").digest;

const OUTSIDE_ADDRESSES = [
  "https://example.com",
  "//example.com",
  "/\\example.com",
  "/\t/example.com",
] as const;

describe("two-step challenge page", () => {
  for (const value of OUTSIDE_ADDRESSES) {
    it(`sends a satisfied platform_ops account to /admin, not to ${JSON.stringify(value)}`, async () => {
      givenSession("platform_ops", "satisfied");
      await expect(MfaChallengePage(withCallbackUrl(value))).rejects.toMatchObject({
        digest: redirectDigest("/admin"),
      });
    });
  }

  it("sends a satisfied finance_ops account to / for an outside address", async () => {
    givenSession("finance_ops", "satisfied");
    await expect(MfaChallengePage(withCallbackUrl("https://example.com"))).rejects.toMatchObject({
      digest: redirectDigest("/"),
    });
  });

  it("keeps a path on this site", async () => {
    givenSession("platform_ops", "satisfied");
    await expect(MfaChallengePage(withCallbackUrl("/admin/payments"))).rejects.toMatchObject({
      digest: redirectDigest("/admin/payments"),
    });
  });

  it("passes only a checked address on to enrolment", async () => {
    givenSession("platform_ops", "enrolment_required");
    await expect(MfaChallengePage(withCallbackUrl("//example.com"))).rejects.toMatchObject({
      digest: redirectDigest("/auth/mfa/enroll?callbackUrl=%2Fadmin"),
    });
  });

  it("hands the form only a checked address", async () => {
    givenSession("platform_ops", "challenge_required");
    const page = await MfaChallengePage(withCallbackUrl("//example.com"));
    expect(page.props.children.type).toBe(MfaChallengeForm);
    expect(page.props.children.props.callbackUrl).toBe("/admin");
  });
});

describe("two-step enrolment page", () => {
  for (const value of OUTSIDE_ADDRESSES) {
    it(`sends a satisfied platform_ops account to /admin, not to ${JSON.stringify(value)}`, async () => {
      givenSession("platform_ops", "satisfied");
      await expect(MfaEnrollPage(withCallbackUrl(value))).rejects.toMatchObject({
        digest: redirectDigest("/admin"),
      });
    });
  }

  it("keeps a path on this site", async () => {
    givenSession("platform_ops", "satisfied");
    await expect(MfaEnrollPage(withCallbackUrl("/admin/payments"))).rejects.toMatchObject({
      digest: redirectDigest("/admin/payments"),
    });
  });

  it("passes only a checked address on to the challenge", async () => {
    givenSession("platform_ops", "challenge_required");
    await expect(MfaEnrollPage(withCallbackUrl("https://example.com"))).rejects.toMatchObject({
      digest: redirectDigest("/auth/mfa/challenge?callbackUrl=%2Fadmin"),
    });
  });

  it("hands the form only a checked address", async () => {
    givenSession("platform_ops", "enrolment_required");
    mocks.start.mockResolvedValueOnce({ secretBase32: "S", otpauthUri: "otpauth://totp/x" });
    mocks.qr.mockResolvedValueOnce("data:image/png;base64,");
    const page = await MfaEnrollPage(withCallbackUrl("https://example.com"));
    expect(page.props.children.type).toBe(MfaEnrollForm);
    expect(page.props.children.props.callbackUrl).toBe("/admin");
  });

  it("passes only a checked address on when the factor is already enrolled", async () => {
    givenSession("platform_ops", "enrolment_required");
    mocks.start.mockRejectedValueOnce(
      new MfaError("mfa_already_enrolled", 409, "already enrolled"),
    );
    await expect(MfaEnrollPage(withCallbackUrl("https://example.com"))).rejects.toMatchObject({
      digest: redirectDigest("/auth/mfa/challenge?callbackUrl=%2Fadmin"),
    });
  });
});
