// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  describeMfaLockout,
  describeMfaThrottle,
  presentMfaError,
  readMfaErrorPayload,
} from "./mfa-error-response";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("readMfaErrorPayload", () => {
  it("reads code, message and retryAfterSeconds from a refusal that engaged a lockout", async () => {
    const payload = await readMfaErrorPayload(
      jsonResponse({
        error: { code: "mfa_invalid_code", message: "Invalid", retryAfterSeconds: 900 },
      }),
    );

    // The code stays `mfa_invalid_code` — that attempt really was a wrong code — while the duration
    // rides alongside it. A form keying only on the code would miss the lock entirely.
    expect(payload).toEqual({
      code: "mfa_invalid_code",
      message: "Invalid",
      retryAfterSeconds: 900,
    });
  });

  it("reports no lockout when the field is absent", async () => {
    const payload = await readMfaErrorPayload(
      jsonResponse({ error: { code: "mfa_invalid_code", message: "Invalid" } }),
    );

    expect(payload.retryAfterSeconds).toBeNull();
  });

  it("treats a non-positive or non-numeric duration as no lockout", async () => {
    const zero = await readMfaErrorPayload(jsonResponse({ error: { retryAfterSeconds: 0 } }));
    const text = await readMfaErrorPayload(jsonResponse({ error: { retryAfterSeconds: "900" } }));

    // Zero would render as "try again in about a minute" for a lock that is not in force.
    expect(zero.retryAfterSeconds).toBeNull();
    expect(text.retryAfterSeconds).toBeNull();
  });

  it("survives a body that is not JSON at all", async () => {
    const payload = await readMfaErrorPayload(new Response("<html>502</html>"));

    expect(payload).toEqual({ code: null, message: null, retryAfterSeconds: null });
  });
});

describe("describeMfaLockout", () => {
  it("rounds the wait up to whole minutes", () => {
    expect(describeMfaLockout(900)).toContain("sekitar 15 menit");
    expect(describeMfaLockout(841)).toContain("sekitar 15 menit");
  });

  it("does not say 'about 0 minutes' for a lock with seconds left", () => {
    expect(describeMfaLockout(20)).toContain("sekitar satu menit");
  });

  it("names support, because an operator without authenticator or recovery codes has no other path", () => {
    expect(describeMfaLockout(900)).toContain("dukungan Lombakita");
  });
});

describe("describeMfaThrottle", () => {
  it("reports a sub-minute wait in seconds", () => {
    expect(describeMfaThrottle(37)).toContain("37 detik");
  });

  it("reports a longer wait in minutes", () => {
    expect(describeMfaThrottle(120)).toContain("sekitar 2 menit");
  });

  it("never claims the account is locked or points at support", () => {
    const message = describeMfaThrottle(30);

    // A throttled operator may not have typed a single wrong code. Reusing the lockout copy would
    // describe an event that did not happen and send them to support for something that clears
    // itself in half a minute.
    expect(message).not.toContain("dikunci");
    expect(message).not.toContain("dukungan");
  });
});

describe("presentMfaError", () => {
  it("renders a lockout as a persistent panel", () => {
    const result = presentMfaError({
      code: "mfa_locked_out",
      message: "Too many failed attempts",
      retryAfterSeconds: 900,
    });

    expect(result).toEqual({
      render: "panel",
      message: describeMfaLockout(900),
      retryAfterSeconds: 900,
    });
  });

  it("renders the wrong code that engaged a lock as the lockout panel too", () => {
    const result = presentMfaError({
      code: "mfa_invalid_code",
      message: "Invalid verification code",
      retryAfterSeconds: 900,
    });

    expect(result.render).toBe("panel");
  });

  it("renders a throttle as a transient toast, never the lockout panel", () => {
    const result = presentMfaError({
      code: "mfa_rate_limited",
      message: "Too many verification requests",
      retryAfterSeconds: 45,
    });

    // The defect this classifier exists to prevent: branching on the mere presence of
    // retryAfterSeconds sends a 429 — which carries one — to the "account locked, contact support"
    // panel, at an operator who has submitted nothing wrong.
    expect(result.render).toBe("toast");
    expect(result.message).toBe(describeMfaThrottle(45));
    // The lifetime is the fix: the primitive defaults to 5000ms, so a toast reading "wait 45
    // detik" would vanish after five seconds and take the only actionable fact with it.
    expect(result).toMatchObject({ durationMs: 45_000 });
  });

  it("renders the fail-closed 503 as a toast with no wait implied", () => {
    const result = presentMfaError({
      code: "mfa_rate_limit_unavailable",
      message: "Verification is temporarily unavailable — try again shortly",
      retryAfterSeconds: null,
    });

    expect(result.render).toBe("toast");
    expect(result.message).toContain("gangguan sistem");
    // Must NOT promise that waiting helps — nothing the operator does clears a Redis outage.
    expect(result.message).not.toContain("sebentar lagi");
    // Names it as a platform fault rather than operator error.
    expect(result.message).toContain("bukan kesalahan Anda");
    // 0 = persists until dismissed. "The platform is degraded" is not a five-second fact.
    expect(result).toMatchObject({ durationMs: 0 });
  });

  it("gives an elevation failure the same treatment as a limiter failure", () => {
    const result = presentMfaError({
      code: "mfa_elevation_unavailable",
      message: "Verification succeeded but the session could not be elevated — try again",
      retryAfterSeconds: null,
    });

    // Both codes mean one thing: Redis is unreachable. Rendering them differently would show the
    // same outage as a persistent Indonesian system notice on one route and a five-second English
    // toast promising a retry on the other — and retrying is exactly what does not help.
    expect(result).toEqual(
      presentMfaError({
        code: "mfa_rate_limit_unavailable",
        message: "Verification is temporarily unavailable",
        retryAfterSeconds: null,
      }),
    );
    expect(result).toMatchObject({ render: "toast", durationMs: 0 });
  });

  it("does not render a panel for an unrelated code that happens to carry a wait", () => {
    // The classifier asks WHAT HAPPENED, not whether a number arrived. A refusal outside the lockout
    // set carrying a duration must not inherit "your account is locked for wrong codes".
    const result = presentMfaError({
      code: "mfa_not_enrolled",
      message: "No verified MFA factor for this account",
      retryAfterSeconds: 900,
    });

    expect(result.render).toBe("toast");
  });

  it("falls back to a toast for an ordinary refusal carrying no wait", () => {
    const result = presentMfaError({
      code: "mfa_invalid_code",
      message: null,
      retryAfterSeconds: null,
    });

    expect(result).toEqual({
      render: "toast",
      message: "Kode tidak valid. Coba lagi.",
      durationMs: 5000,
    });
  });

  // The shape a live wrong code actually produces: the server sends its English API message and no
  // duration, because the lock has not engaged yet. Passing `message: null` — as the case above
  // does — cannot detect the server's wording being forwarded, which is how English reached an
  // operator on the single most frequent refusal in the flow.
  it("never shows the server's English message for an ordinary wrong code", () => {
    const result = presentMfaError({
      code: "mfa_invalid_code",
      message: "Invalid verification code",
      retryAfterSeconds: null,
    });

    expect(result).toEqual({
      render: "toast",
      message: "Kode tidak valid. Coba lagi.",
      durationMs: 5000,
    });
  });

  // Every refusal that reaches the toast arm, each carrying the English message its endpoint really
  // sends. None of them may surface it.
  it.each([
    ["mfa_invalid_recovery_code", "Invalid or already used recovery code"],
    ["mfa_already_enrolled", "This account already has a verified MFA factor"],
    ["mfa_enrolment_not_found", "No pending enrolment for this account"],
    ["mfa_not_enrolled", "No verified MFA factor for this account"],
  ])("renders %s in Indonesian rather than the server's wording", (code, serverMessage) => {
    const result = presentMfaError({ code, message: serverMessage, retryAfterSeconds: null });

    expect(result.render).toBe("toast");
    expect(result.message).not.toBe(serverMessage);
    expect(result.message).not.toMatch(/[a-z]+ (account|code|factor|verification)\b/i);
  });

  // An unrecognised code is the case that decides whether the passthrough can come back: it must
  // reach generic Indonesian copy, not the server's string.
  it("renders an unknown code in Indonesian rather than the server's wording", () => {
    const result = presentMfaError({
      code: "mfa_some_future_code",
      message: "Something went wrong upstream",
      retryAfterSeconds: null,
    });

    expect(result).toEqual({
      render: "toast",
      message:
        "Verifikasi dua langkah gagal. Coba lagi, atau hubungi tim platform Lombakita jika terus berlanjut.",
      durationMs: 5000,
    });
  });
});
