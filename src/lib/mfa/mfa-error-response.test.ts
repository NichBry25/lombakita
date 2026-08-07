// @vitest-environment node

import { describe, expect, it } from "vitest";
import { describeMfaLockout, readMfaErrorPayload } from "./mfa-error-response";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("readMfaErrorPayload", () => {
  it("reads code, message and retryAfterSeconds from a refusal that engaged a lockout", async () => {
    const payload = await readMfaErrorPayload(
      jsonResponse({ error: { code: "mfa_invalid_code", message: "Invalid", retryAfterSeconds: 900 } }),
    );

    // The code stays `mfa_invalid_code` — that attempt really was a wrong code — while the duration
    // rides alongside it. A form keying only on the code would miss the lock entirely.
    expect(payload).toEqual({ code: "mfa_invalid_code", message: "Invalid", retryAfterSeconds: 900 });
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
