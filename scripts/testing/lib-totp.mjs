/*
 * RFC 6238 TOTP for the test harness — the same 30s/6-digit/SHA-1 parameters as
 * src/server/auth/mfa/totp.ts, restated here rather than imported because these scripts are plain
 * .mjs and must not pull an `@/`-aliased server module (which would evaluate env.server.ts).
 *
 * If the app's parameters ever change, this changes with them: a code generated here that the
 * server rejects makes every operational seed session fail to elevate, which is a loud failure
 * rather than a silent one.
 */
import { createHmac } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;

export const generateTotpCode = (secret, atSeconds = Math.floor(Date.now() / 1000)) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atSeconds / STEP_SECONDS)));

  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binary % 10 ** DIGITS).toString(10).padStart(DIGITS, "0");
};
