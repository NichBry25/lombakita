// @vitest-environment node

import { describe, expect, it } from "vitest";
import { generateTotpCode, totpStepForTime, verifyTotpCode } from "./totp";

// RFC 6238 Appendix B test vectors, SHA-1 arm, truncated to 6 digits (the RFC publishes the
// 8-digit truncation; the last 6 digits of each are the widely-cited 6-digit equivalents used by
// every real authenticator app, since HOTP truncation is `binary mod 10^digits`).
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_VECTORS: Array<[number, string]> = [
  [59, "287082"],
  [1_111_111_109, "081804"],
  [1_111_111_111, "050471"],
  [1_234_567_890, "005924"],
  [2_000_000_000, "279037"],
];

describe("generateTotpCode — RFC 6238 Appendix B vectors", () => {
  it.each(RFC_VECTORS)("produces %s's 6-digit code at unix time %i", (atSeconds, expected) => {
    expect(generateTotpCode(RFC_SECRET, atSeconds)).toBe(expected);
  });
});

describe("totpStepForTime", () => {
  it("floors to the 30-second step", () => {
    expect(totpStepForTime(0)).toBe(0);
    expect(totpStepForTime(29)).toBe(0);
    expect(totpStepForTime(30)).toBe(1);
    expect(totpStepForTime(59)).toBe(1);
    expect(totpStepForTime(60)).toBe(2);
  });
});

describe("verifyTotpCode", () => {
  const secret = RFC_SECRET;
  const now = 1_111_111_111; // matches an RFC vector, code "050471"

  it("accepts the correct current-step code", () => {
    const result = verifyTotpCode(secret, "050471", now);
    expect(result.valid).toBe(true);
    expect(result.matchedStep).toBe(totpStepForTime(now));
  });

  it("rejects a garbled or wrong-length code", () => {
    expect(verifyTotpCode(secret, "5047", now).valid).toBe(false);
    expect(verifyTotpCode(secret, "abcdef", now).valid).toBe(false);
  });

  it("rejects an out-of-window code", () => {
    // Code for a step 3 windows away should not verify with windowSteps: 1.
    const farStep = totpStepForTime(now) + 5;
    const farCode = generateTotpCode(secret, farStep * 30);
    expect(verifyTotpCode(secret, farCode, now, { windowSteps: 1 }).valid).toBe(false);
  });

  it("accepts a code one step in the past within the acceptance window", () => {
    const pastCode = generateTotpCode(secret, now - 30);
    const result = verifyTotpCode(secret, pastCode, now, { windowSteps: 1 });
    expect(result.valid).toBe(true);
    expect(result.matchedStep).toBe(totpStepForTime(now) - 1);
  });

  it("accepts a code one step in the future within the acceptance window", () => {
    const futureCode = generateTotpCode(secret, now + 30);
    const result = verifyTotpCode(secret, futureCode, now, { windowSteps: 1 });
    expect(result.valid).toBe(true);
    expect(result.matchedStep).toBe(totpStepForTime(now) + 1);
  });

  // GUARD-REMOVAL PROOF target: the `candidateStep <= lastAcceptedStep` skip. Without it, a code
  // captured once (shoulder-surfed, logged, replayed from a proxy) would verify again for the rest
  // of its 90-second acceptance window.
  it("refuses a code whose step is at or before lastAcceptedStep — the replay guard", () => {
    const currentStep = totpStepForTime(now);
    const code = generateTotpCode(secret, now);

    const firstUse = verifyTotpCode(secret, code, now, { lastAcceptedStep: null });
    expect(firstUse.valid).toBe(true);
    expect(firstUse.matchedStep).toBe(currentStep);

    // Same code, same instant, but the caller now reports it as already spent.
    const replay = verifyTotpCode(secret, code, now, { lastAcceptedStep: currentStep });
    expect(replay.valid).toBe(false);
  });

  it("still accepts a DIFFERENT later step after one has been spent", () => {
    const currentStep = totpStepForTime(now);
    const nextCode = generateTotpCode(secret, now + 30);

    const result = verifyTotpCode(secret, nextCode, now + 30, {
      windowSteps: 1,
      lastAcceptedStep: currentStep,
    });

    expect(result.valid).toBe(true);
    expect(result.matchedStep).toBe(currentStep + 1);
  });

  it("is constant-shape regardless of wrong-code content (no throw on any input)", () => {
    expect(() => verifyTotpCode(secret, "", now)).not.toThrow();
    expect(() => verifyTotpCode(secret, "999999999999", now)).not.toThrow();
  });
});
