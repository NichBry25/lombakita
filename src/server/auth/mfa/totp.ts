import { createHmac, timingSafeEqual } from "node:crypto";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/mfa/totp");

// RFC 6238 TOTP over RFC 4226 HOTP. 30-second step, 6 digits, SHA-1 — the parameters every
// authenticator app (Google Authenticator, Authy, 1Password, etc.) assumes when it is handed a
// bare otpauth:// URI with no algorithm/digits/period override. No dependency: the whole algorithm
// is HMAC-SHA1 plus dynamic truncation, already available from node:crypto.
//
// Pure with respect to the clock: every function here takes time as an explicit parameter rather
// than reading Date.now() itself, so the replay guard and the acceptance window are exercised
// deterministically in tests.

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const HOTP_COUNTER_BYTES = 8;

const DIGIT_MODULUS = 10 ** TOTP_DIGITS;

const hotp = (secret: Buffer, counter: number): string => {
  const counterBuffer = Buffer.alloc(HOTP_COUNTER_BYTES);
  // Counters here are always small (seconds-since-epoch / 30), far under Number.MAX_SAFE_INTEGER,
  // so a plain writeBigUInt64BE from a BigInt cast is exact.
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac("sha1", secret).update(counterBuffer).digest();

  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const code = binary % DIGIT_MODULUS;
  return code.toString(10).padStart(TOTP_DIGITS, "0");
};

export const totpStepForTime = (atSeconds: number, stepSeconds: number = TOTP_STEP_SECONDS): number => {
  return Math.floor(atSeconds / stepSeconds);
};

export const generateTotpCode = (
  secret: Buffer,
  atSeconds: number,
  stepSeconds: number = TOTP_STEP_SECONDS,
): string => {
  return hotp(secret, totpStepForTime(atSeconds, stepSeconds));
};

const codesEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

export type TotpVerification = {
  valid: boolean;
  // The step the code matched, when valid. Callers persist this as the new replay-guard floor —
  // a later verification must reject any step at or below it.
  matchedStep: number | null;
};

// Verifies `code` against the ±windowSteps acceptance window around `atSeconds`, and enforces the
// replay guard: a step at or below `lastAcceptedStep` is refused even if the code is otherwise
// correct, because it was already spent. Checks the CURRENT step first, then walks outward
// (−1, +1, −2, +2, …) — irrelevant to correctness, but means the common case (a code entered
// promptly) does the least work.
export const verifyTotpCode = (
  secret: Buffer,
  code: string,
  atSeconds: number,
  options: {
    windowSteps?: number;
    lastAcceptedStep?: number | null;
    stepSeconds?: number;
  } = {},
): TotpVerification => {
  const windowSteps = options.windowSteps ?? 1;
  const stepSeconds = options.stepSeconds ?? TOTP_STEP_SECONDS;
  const lastAcceptedStep = options.lastAcceptedStep ?? null;

  if (!/^\d{6}$/.test(code)) {
    return { valid: false, matchedStep: null };
  }

  const currentStep = totpStepForTime(atSeconds, stepSeconds);
  const order: number[] = [0];
  for (let delta = 1; delta <= windowSteps; delta += 1) {
    order.push(-delta, delta);
  }

  for (const delta of order) {
    const candidateStep = currentStep + delta;
    if (lastAcceptedStep !== null && candidateStep <= lastAcceptedStep) {
      // Already-spent step. Skipped, not treated as a mismatch worth reporting differently — the
      // caller only learns "invalid", which is correct: revealing "that code already worked" would
      // leak information to anyone shoulder-surfing a stale code.
      continue;
    }
    if (codesEqual(hotp(secret, candidateStep), code)) {
      return { valid: true, matchedStep: candidateStep };
    }
  }

  return { valid: false, matchedStep: null };
};
