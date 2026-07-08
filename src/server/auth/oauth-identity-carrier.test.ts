// @vitest-environment node
//
// Step 6.5d — transient Google-identity carrier integrity tests. The carrier crosses the
// role-picker round trip in the redirect URL; it must be unforgeable and tamper-evident. These
// tests verify the HMAC roundtrip plus rejection of every tamper/expiry/format failure mode.

import { createHmac } from "crypto";
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
  it("round-trips signed claims back to the original values, carrying jti + exp", () => {
    const token = signGoogleIdentityCarrier(baseClaims, 1000, "jti-abc");
    const claims = verifyGoogleIdentityCarrier(token, 1001);

    // exp = iat + 900. The verified carrier is the identity claims plus the nonce fields the
    // single-use consume needs (jti, exp).
    expect(claims).toEqual({ ...baseClaims, jti: "jti-abc", exp: 1900 });
  });

  it("mints a distinct random jti per carrier when none is supplied", () => {
    const a = verifyGoogleIdentityCarrier(signGoogleIdentityCarrier(baseClaims, 1000), 1001);
    const b = verifyGoogleIdentityCarrier(signGoogleIdentityCarrier(baseClaims, 1000), 1001);

    expect(a?.jti).toBeTruthy();
    expect(b?.jti).toBeTruthy();
    expect(a?.jti).not.toEqual(b?.jti);
  });

  it("rejects a carrier with no jti (e.g. minted before the single-use upgrade) — fail closed", () => {
    // Hand-build a validly-signed legacy carrier that omits jti, to prove verify now requires it.
    const legacyPayload = Buffer.from(
      JSON.stringify({
        provider: "google",
        providerAccountId: "google-sub-123",
        email: "user@example.com",
        emailVerified: true,
        name: "Test User",
        image: "https://example.com/avatar.png",
        iat: 1000,
        exp: 999999999,
      }),
    ).toString("base64url");
    // Sign with the same key the module uses (mocked authSecret) so signature verification passes and
    // the ONLY reason for rejection is the missing jti.
    const signature = createHmac("sha256", "test-auth-secret-please-change")
      .update(legacyPayload)
      .digest("base64url");
    const legacyToken = `${legacyPayload}.${signature}`;

    expect(verifyGoogleIdentityCarrier(legacyToken, 1001)).toBeNull();
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
    const token = signGoogleIdentityCarrier(baseClaims, 1000, "jti-boundary");
    // exp = 1900; exactly-at-exp is still valid (reject only when exp < now).
    expect(verifyGoogleIdentityCarrier(token, 1900)).toEqual({
      ...baseClaims,
      jti: "jti-boundary",
      exp: 1900,
    });
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
      "jti-optional",
    );
    expect(verifyGoogleIdentityCarrier(token, 1001)).toEqual({
      ...baseClaims,
      name: null,
      image: null,
      jti: "jti-optional",
      exp: 1900,
    });
  });
});
