import { randomUUID } from "node:crypto";
import { consumeStoredGrant, issueStoredGrant } from "@/server/redis/rate-limit";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/mfa/mfa-elevation");

// The single-use, short-lived elevation grant that bridges a successful TOTP/recovery-code
// challenge to the JWT.
//
// next-auth v4's `update()` trigger passes CLIENT-SUPPLIED data into the jwt callback. If the
// callback trusted that payload directly, `update({ mfaVerified: true })` typed into a browser
// console would be a complete bypass — no code, no server round trip, just a boolean the client
// asserts about itself. The fix is the same shape as the OAuth carrier's single-use nonce
// (oauth-identity-carrier.ts / rate-limit.ts consumeSingleUseToken): the challenge endpoint proves
// the code server-side and writes an opaque, unguessable grant id to Redis; the CLIENT never sees
// anything but that id, and the jwt callback's only trust decision is "did consuming this id
// return the userId this token belongs to" — never anything the client asserted about itself.
//
// Redis being unavailable at challenge time means a grant cannot be positively confirmed stored,
// so elevation is refused (server/redis/rate-limit.ts's fail-closed issueStoredGrant/
// consumeStoredGrant). That is the correct failure mode here, not an unfortunate side effect:
// operational-role sessions already fail closed on any live-account-state read failure
// (DEC-0112), and MFA elevation is exactly that kind of gate.

const ELEVATION_GRANT_TTL_SECONDS = 120;
const ELEVATION_GRANT_KEY_PREFIX = "mfa_elevation_grant:";

// Issues a fresh grant bound to `userId` and returns its opaque id. Called ONLY from server code
// that has already verified a TOTP code or recovery code for that exact user.
export const issueMfaElevationGrant = async (userId: string): Promise<string> => {
  const grantId = randomUUID();
  await issueStoredGrant({
    key: `${ELEVATION_GRANT_KEY_PREFIX}${grantId}`,
    value: userId,
    ttlSeconds: ELEVATION_GRANT_TTL_SECONDS,
  });
  return grantId;
};

// Consumes a grant and returns the userId it was issued for, or null if the id is missing,
// expired, or already consumed (single use). Throws if Redis cannot confirm either way — the jwt
// callback catches this and simply does not elevate, exactly as it does for a missing grant.
export const consumeMfaElevationGrant = async (grantId: string): Promise<string | null> => {
  return consumeStoredGrant(`${ELEVATION_GRANT_KEY_PREFIX}${grantId}`);
};
