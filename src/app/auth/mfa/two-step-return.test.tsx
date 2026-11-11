// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { getRedirectError } from "next/dist/client/components/redirect";
import MfaChallengePage from "./challenge/page";
import MfaEnrollPage from "./enroll/page";

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
vi.mock("@/server/auth/mfa/mfa-encryption", () => ({
  encryptMfaSecret: () => ({ ciphertext: "ciphertext", iv: "iv", authTag: "tag" }),
  decryptMfaSecret: vi.fn(),
}));
vi.mock("@/server/auth/mfa/otpauth-qr", () => ({ renderOtpauthQrDataUrl: mocks.qr }));

type SessionUser = NonNullable<Session["user"]>;

const signIn = (role: SessionUser["role"], mfaStatus: SessionUser["mfaStatus"]): void => {
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
      signIn("platform_ops", "satisfied");
      await expect(MfaChallengePage(withCallbackUrl(value))).rejects.toMatchObject({
        digest: redirectDigest("/admin"),
      });
    });
  }

  it("sends a satisfied finance_ops account to / for an outside address", async () => {
    signIn("finance_ops", "satisfied");
    await expect(MfaChallengePage(withCallbackUrl("https://example.com"))).rejects.toMatchObject({
      digest: redirectDigest("/"),
    });
  });

  it("keeps a path on this site", async () => {
    signIn("platform_ops", "satisfied");
    await expect(MfaChallengePage(withCallbackUrl("/admin/payments"))).rejects.toMatchObject({
      digest: redirectDigest("/admin/payments"),
    });
  });

  it("passes only a checked address on to enrolment", async () => {
    signIn("platform_ops", "enrolment_required");
    await expect(MfaChallengePage(withCallbackUrl("//example.com"))).rejects.toMatchObject({
      digest: redirectDigest("/auth/mfa/enroll?callbackUrl=%2Fadmin"),
    });
  });
});

describe("two-step enrolment page", () => {
  for (const value of OUTSIDE_ADDRESSES) {
    it(`sends a satisfied platform_ops account to /admin, not to ${JSON.stringify(value)}`, async () => {
      signIn("platform_ops", "satisfied");
      await expect(MfaEnrollPage(withCallbackUrl(value))).rejects.toMatchObject({
        digest: redirectDigest("/admin"),
      });
    });
  }

  it("keeps a path on this site", async () => {
    signIn("platform_ops", "satisfied");
    await expect(MfaEnrollPage(withCallbackUrl("/admin/payments"))).rejects.toMatchObject({
      digest: redirectDigest("/admin/payments"),
    });
  });

  it("passes only a checked address on to the challenge", async () => {
    signIn("platform_ops", "challenge_required");
    await expect(MfaEnrollPage(withCallbackUrl("https://example.com"))).rejects.toMatchObject({
      digest: redirectDigest("/auth/mfa/challenge?callbackUrl=%2Fadmin"),
    });
  });
});
