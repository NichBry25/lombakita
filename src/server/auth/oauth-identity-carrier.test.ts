// @vitest-environment node
//
// Step 6.5d — transient Google-identity carrier integrity tests. The carrier crosses the
// role-picker round trip in the redirect URL; it must be unforgeable and tamper-evident. These
// tests verify the HMAC roundtrip plus rejection of every tamper/expiry/format failure mode.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/config/env.server", () => ({
  serverEnv: { authSecret: "test-auth-secret-please-change" },
}));

import {
  signGoogleIdentityCarrier,
  verifyGoogleIdentityCarrier,
  type GoogleIdentityClaims,
} from "@/server/auth/oauth-identity-carrier";

const baseClaims: GoogleIdentityClaims = {
  provider: "google",
  providerAccountId: "google-sub-123",
  email: "user@example.com",
  emailVerified: true,
  name: "Test User",
  image: "https://example.com/avatar.png",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("oauth identity carrier", () => {
  it("round-trips signed claims back to the original values", () => {
    const token = signGoogleIdentityCarrier(baseClaims, 1000);
    const claims = verifyGoogleIdentityCarrier(token, 1001);

    expect(claims).toEqual(baseClaims);
  });

  it("rejects a carrier whose payload was tampered with (signature no longer matches)", () => {
    const token = signGoogleIdentityCarrier(baseClaims, 1000);
    const dot = token.indexOf(".");
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);

    // Flip one byte of the payload — the original signature no longer verifies.
    const tamperedPayload = `${payload.slice(0, -1)}${payload.slice(-1) === "A" ? "B" : "A"}`;
    const tampered = `${tamperedPayload}.${signature}`;

    expect(verifyGoogleIdentityCarrier(tampered, 1001)).toBeNull();
  });

  it("rejects a carrier whose signature was tampered with", () => {
    const token = signGoogleIdentityCarrier(baseClaims, 1000);
    const dot = token.indexOf(".");
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const tampered = `${payload}.${signature.slice(0, -1)}${signature.slice(-1) === "A" ? "B" : "A"}`;

    expect(verifyGoogleIdentityCarrier(tampered, 1001)).toBeNull();
  });

  it("rejects an attacker-forged token signed with the wrong key shape (no valid HMAC)", () => {
    // A payload that decodes to an attacker-chosen, verified identity, but with a bogus signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({
        provider: "google",
        providerAccountId: "attacker",
        email: "victim@example.com",
        emailVerified: true,
        iat: 1000,
        exp: 999999999,
      }),
    ).toString("base64url");
    const forged = `${forgedPayload}.${Buffer.from("not-a-real-signature").toString("base64url")}`;

    expect(verifyGoogleIdentityCarrier(forged, 1001)).toBeNull();
  });

  it("rejects an expired carrier", () => {
    const token = signGoogleIdentityCarrier(baseClaims, 1000);
    // exp = 1000 + 900 = 1900; verify well past it.
    expect(verifyGoogleIdentityCarrier(token, 5000)).toBeNull();
  });

  it("accepts a carrier right up to its expiry boundary", () => {
    const token = signGoogleIdentityCarrier(baseClaims, 1000);
    // exp = 1900; exactly-at-exp is still valid (reject only when exp < now).
    expect(verifyGoogleIdentityCarrier(token, 1900)).toEqual(baseClaims);
  });

  it("rejects malformed input (no separator, empty, non-string)", () => {
    expect(verifyGoogleIdentityCarrier("no-dot-here")).toBeNull();
    expect(verifyGoogleIdentityCarrier("")).toBeNull();
    expect(verifyGoogleIdentityCarrier(undefined)).toBeNull();
    expect(verifyGoogleIdentityCarrier(123 as unknown)).toBeNull();
  });

  it("normalizes missing optional fields to null on verify", () => {
    const token = signGoogleIdentityCarrier(
      { ...baseClaims, name: null, image: null },
      1000,
    );
    expect(verifyGoogleIdentityCarrier(token, 1001)).toEqual({
      ...baseClaims,
      name: null,
      image: null,
    });
  });
});
