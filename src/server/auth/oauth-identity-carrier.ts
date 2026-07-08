import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { serverEnv } from "@/config/env.server";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/oauth-identity-carrier");

// Step 6.5d — transient Google-identity carrier.
//
// When a brand-new Google user (no linked account, no existing same-email account) signs in, the
// signIn callback must NOT create a users row before a role is declared (the
// `users_one_verified_role_chk` trap). Instead it routes the browser to the role picker carrying
// the Google identity across the round trip. That identity must be integrity-protected: an
// attacker must not be able to forge a carrier asserting an arbitrary email or a verified status,
// nor tamper with the values issued by the server.
//
// Mechanism (stated explicitly): an HMAC-SHA256-signed, base64url-encoded token of the form
// `<payload>.<signature>` where signature = HMAC(AUTH_SECRET, payload). This is stateless and
// integrity-protected — any change to a single byte of the payload invalidates the signature, so
// the carrier is unforgeable without AUTH_SECRET and tamper-evident on verify. It carries a short
// TTL (15 min) so a leaked carrier (it travels in the redirect URL — see the trade-off note below)
// is only briefly useful.
//
// Why a signed URL token and not a cookie or a server-side (Redis) record:
//   - next-auth v4's signIn callback can only abort the OAuth flow by RETURNING A REDIRECT STRING
//     (core/routes/callback.js). It cannot attach an arbitrary Set-Cookie to that redirect, so an
//     httpOnly cookie carrier is not reachable from the interception point.
//   - A Redis-stored payload keyed by an opaque nonce would also work but adds infrastructure
//     coupling for a value the HMAC already protects. Deferred unless a stronger anti-replay
//     guarantee is required.
// Trade-off accepted: the carrier travels as a query param, so it can appear in browser history /
// referrer. Mitigated by the 15-minute TTL and that finalization is idempotent (replay only
// re-attempts creating the same account the holder already proved they control via Google), so
// replay yields no privilege gain. A one-time nonce store can be layered on later if needed.

const CARRIER_TTL_SECONDS = 15 * 60;

export type GoogleIdentityClaims = {
  provider: "google";
  // Google's stable subject identifier — becomes accounts.providerAccountId.
  providerAccountId: string;
  // Normalized (lowercased/trimmed) Google account email.
  email: string;
  // Google's own email_verified flag. Consumed ONLY for the safe-link decision and to set the
  // Auth.js users.emailVerified column at creation — NEVER written as a role-verification
  // timestamp (candidate_verified_at / recruiter_verified_at).
  emailVerified: boolean;
  name: string | null;
  image: string | null;
};

// `jti` is a per-carrier nonce (auth-D2 / 6.5d-D2). It is consumed once via an atomic Redis SET NX at
// finalize so a captured carrier URL cannot be redeemed twice inside its TTL. It is not an identity
// field, so it is carried alongside iat/exp, not in GoogleIdentityClaims.
type SignedClaims = GoogleIdentityClaims & { iat: number; exp: number; jti: string };

// What a verified carrier yields: the identity claims plus the fields the single-use consume needs —
// `jti` (the nonce key) and `exp` (used to give the nonce a TTL matching the carrier's own expiry).
export type VerifiedGoogleIdentityCarrier = GoogleIdentityClaims & { jti: string; exp: number };

const base64url = (input: Buffer | string): string => {
  return Buffer.from(input).toString("base64url");
};

const sign = (payload: string): string => {
  const secret = serverEnv.authSecret;
  if (!secret) {
    // AUTH_SECRET is a hard web-runtime requirement (assertRuntimeEnv("web")); reaching here means
    // misconfiguration. Fail loud rather than emit an unverifiable token.
    throw new Error("oauth_carrier_secret_missing");
  }
  return createHmac("sha256", secret).update(payload).digest("base64url");
};

// Constant-time signature comparison. Returns false on any length/format mismatch.
const signaturesEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};

export const signGoogleIdentityCarrier = (
  claims: GoogleIdentityClaims,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  jti: string = randomUUID(),
): string => {
  const signed: SignedClaims = {
    ...claims,
    iat: nowSeconds,
    exp: nowSeconds + CARRIER_TTL_SECONDS,
    jti,
  };
  const payload = base64url(JSON.stringify(signed));
  return `${payload}.${sign(payload)}`;
};

// Verifies integrity + expiry and returns the claims, or null on ANY failure (malformed, bad
// signature, expired). Callers treat null as "reject / fail closed" — they never trust a carrier
// that does not verify.
export const verifyGoogleIdentityCarrier = (
  token: unknown,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifiedGoogleIdentityCarrier | null => {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return null;
  }

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }

  if (!signaturesEqual(signature, expected)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const claims = parsed as Record<string, unknown>;

  if (
    claims.provider !== "google" ||
    typeof claims.providerAccountId !== "string" ||
    claims.providerAccountId.length === 0 ||
    typeof claims.email !== "string" ||
    claims.email.length === 0 ||
    typeof claims.emailVerified !== "boolean" ||
    typeof claims.exp !== "number" ||
    // `jti` is required. A carrier without one (e.g. minted before this deploy) fails closed and the
    // user simply re-initiates Google sign-in — carriers are transient (15-min TTL).
    typeof claims.jti !== "string" ||
    claims.jti.length === 0
  ) {
    return null;
  }

  if (claims.exp < nowSeconds) {
    return null;
  }

  return {
    provider: "google",
    providerAccountId: claims.providerAccountId,
    email: claims.email,
    emailVerified: claims.emailVerified,
    name: typeof claims.name === "string" ? claims.name : null,
    image: typeof claims.image === "string" ? claims.image : null,
    jti: claims.jti,
    exp: claims.exp,
  };
};
