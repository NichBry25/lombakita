// @vitest-environment node

// THE TWO REGISTRATION SEND PATHS ARE BOUNDED, AND THE BOUND STOPS THE WORK RATHER THAN REPORTING IT.
//
// Both endpoints were behind no limiter in either family, and there is no middleware above them.
// `resendRegistrationVerification` mints a token and bills a provider send per unauthenticated
// request, so an unbounded endpoint is an email amplifier paid for by the platform and charged to
// its sending reputation.
//
// CLASS C: these are route gates, so the detector is that the SERVICE IS NOT CALLED. Asserting only
// the 429 would pass just as happily on a gate that refused after doing the work it exists to
// prevent, which is the shape Rule 32 is written about.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkFixedWindowLimit, registerUserWithCredentials, resendRegistrationVerification } =
  vi.hoisted(() => ({
    checkFixedWindowLimit: vi.fn(),
    registerUserWithCredentials: vi.fn(),
    resendRegistrationVerification: vi.fn(),
  }));

vi.mock("@/server/redis/rate-limit", () => ({ checkFixedWindowLimit }));
vi.mock("@/server/auth/credentials-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/credentials-auth")>();

  return { ...actual, registerUserWithCredentials, resendRegistrationVerification };
});

import { POST as registerPost } from "@/app/api/v1/auth/register/route";
import { POST as resendPost } from "@/app/api/v1/auth/register/resend/route";
import {
  REGISTRATION_RATE_LIMIT,
  REGISTRATION_RESEND_IP_LIMIT,
  VERIFICATION_EMAIL_ADDRESS_LIMIT,
} from "@/server/auth/rate-limit-constants";

const ALLOWED = { allowed: true, retryAfterSeconds: 0 };
const REFUSED = { allowed: false, retryAfterSeconds: 42 };

const postTo = (url: string, body: unknown, ip = "203.0.113.9") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

const registerRequest = (body: unknown, ip?: string) =>
  postTo("http://localhost/api/v1/auth/register?as=candidate", body, ip);

const resendRequest = (body: unknown, ip?: string) =>
  postTo("http://localhost/api/v1/auth/register/resend", body, ip);

/** Which limiter keys a route asked about, in the order it asked. */
const keysChecked = (): string[] =>
  checkFixedWindowLimit.mock.calls.map((call) => (call[0] as { key: string }).key);

beforeEach(() => {
  checkFixedWindowLimit.mockResolvedValue(ALLOWED);
  registerUserWithCredentials.mockResolvedValue({ email: "baru@seed.lombakita.local" });
  resendRegistrationVerification.mockResolvedValue({ email: "baru@seed.lombakita.local" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/auth/register", () => {
  it("is bounded by client IP and by the address being mailed", async () => {
    await registerPost(registerRequest({ email: "baru@seed.lombakita.local" }));

    expect(keysChecked()).toEqual([
      `${REGISTRATION_RATE_LIMIT.keyPrefix}203.0.113.9`,
      `${VERIFICATION_EMAIL_ADDRESS_LIMIT.keyPrefix}baru@seed.lombakita.local`,
    ]);
  });

  it("refuses on the IP bound without creating the account", async () => {
    // ONLY the IP bound refuses; the address bound allows. Refusing both would let the address
    // check mask the IP check, and a probe that removed the IP refusal would still see a 429 and
    // an uncalled service — passing over a bound that had stopped working.
    checkFixedWindowLimit.mockResolvedValueOnce(REFUSED);

    const response = await registerPost(registerRequest({ email: "baru@seed.lombakita.local" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    // The gate's whole point: the work does not happen.
    expect(registerUserWithCredentials).not.toHaveBeenCalled();
  });

  it("refuses on the address bound without creating the account", async () => {
    // IP allowed, address refused: the distributed-attacker case the IP key cannot see, and the
    // reason /register needs an address bound of its own rather than the IP bound alone.
    checkFixedWindowLimit.mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce(REFUSED);

    const response = await registerPost(registerRequest({ email: "korban@seed.lombakita.local" }));

    expect(response.status).toBe(429);
    expect(registerUserWithCredentials).not.toHaveBeenCalled();
  });

  it("skips the IP bound when the client IP cannot be resolved", async () => {
    // An unresolvable IP collapses every caller into one bucket. Sharing it would take signup
    // offline for everybody the moment a forwarded header went missing, so the IP bound is skipped
    // and the address bound carries the request on its own.
    const request = new Request("http://localhost/api/v1/auth/register?as=candidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "baru@seed.lombakita.local" }),
    });

    await registerPost(request);

    expect(keysChecked()).toEqual([
      `${VERIFICATION_EMAIL_ADDRESS_LIMIT.keyPrefix}baru@seed.lombakita.local`,
    ]);
  });

  it("lets a request through under the limit", async () => {
    const response = await registerPost(registerRequest({ email: "baru@seed.lombakita.local" }));

    expect(response.status).toBe(200);
    expect(registerUserWithCredentials).toHaveBeenCalledOnce();
  });
});

describe("the per-address budget", () => {
  it("is one bucket shared by register and resend, so alternating them draws from the same one", async () => {
    // The property that makes the bound mean what it says. Two counters would let a caller
    // alternate the endpoints and collect both allowances against one victim, and each endpoint
    // would report a bound it was not really enforcing.
    await registerPost(registerRequest({ email: "korban@seed.lombakita.local" }));
    await resendPost(resendRequest({ email: "korban@seed.lombakita.local" }));

    const addressKeys = keysChecked().filter((key) =>
      key.startsWith(VERIFICATION_EMAIL_ADDRESS_LIMIT.keyPrefix),
    );

    expect(addressKeys).toEqual([
      `${VERIFICATION_EMAIL_ADDRESS_LIMIT.keyPrefix}korban@seed.lombakita.local`,
      `${VERIFICATION_EMAIL_ADDRESS_LIMIT.keyPrefix}korban@seed.lombakita.local`,
    ]);
  });
});

describe("POST /api/v1/auth/register/resend", () => {
  it("is bounded by client IP and by the address being mailed", async () => {
    await resendPost(resendRequest({ email: "orang@seed.lombakita.local" }));

    expect(keysChecked()).toEqual([
      `${REGISTRATION_RESEND_IP_LIMIT.keyPrefix}203.0.113.9`,
      `${VERIFICATION_EMAIL_ADDRESS_LIMIT.keyPrefix}orang@seed.lombakita.local`,
    ]);
  });

  it("refuses on the IP bound without billing a send", async () => {
    // ONLY the IP bound refuses; the address bound allows. Refusing both would let the address
    // check mask the IP check's position, and the probe that moves the IP check below the send
    // would then pass while the send was being billed.
    checkFixedWindowLimit.mockResolvedValueOnce(REFUSED);

    const response = await resendPost(resendRequest({ email: "orang@seed.lombakita.local" }));

    expect(response.status).toBe(429);
    expect(resendRegistrationVerification).not.toHaveBeenCalled();
  });

  it("refuses on the address bound without billing a send", async () => {
    // IP allowed, address refused: the distributed-attacker case the IP key cannot see.
    checkFixedWindowLimit.mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce(REFUSED);

    const response = await resendPost(resendRequest({ email: "korban@seed.lombakita.local" }));

    expect(response.status).toBe(429);
    expect(resendRegistrationVerification).not.toHaveBeenCalled();
  });

  it("counts one bucket per address however the caller spells it", async () => {
    // Without normalising, varying the case buys a fresh allowance per spelling.
    await resendPost(resendRequest({ email: "  ORANG@Seed.Lombakita.Local  " }));

    expect(keysChecked()).toContain(
      `${VERIFICATION_EMAIL_ADDRESS_LIMIT.keyPrefix}orang@seed.lombakita.local`,
    );
  });

  it("counts the address BEFORE the lookup, so an unknown address is capped too", async () => {
    // A counter advanced only by real sends would cap known addresses alone, making the 429 an
    // existence oracle. The address key must be consulted even when the service will 404.
    resendRegistrationVerification.mockRejectedValue(
      Object.assign(new Error("not found"), { code: "verification_required", status: 404 }),
    );

    await resendPost(resendRequest({ email: "tidak.ada@seed.lombakita.local" })).catch(() => {});

    expect(keysChecked()).toContain(
      `${VERIFICATION_EMAIL_ADDRESS_LIMIT.keyPrefix}tidak.ada@seed.lombakita.local`,
    );
  });
});

describe("the over-limit signal", () => {
  it("is byte-identical for a known and an unknown address", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    const known = await resendPost(resendRequest({ email: "ada@seed.lombakita.local" }));
    const unknown = await resendPost(resendRequest({ email: "tidak.ada@seed.lombakita.local" }));

    expect(await known.text()).toBe(await unknown.text());
    expect(known.status).toBe(unknown.status);
    expect(known.headers.get("Retry-After")).toBe(unknown.headers.get("Retry-After"));
  });

  it("names no reason a caller could use to tell the two limiters apart", async () => {
    checkFixedWindowLimit.mockResolvedValue(REFUSED);

    const onIp = await resendPost(resendRequest({ email: "ada@seed.lombakita.local" }));
    checkFixedWindowLimit.mockResolvedValueOnce(ALLOWED).mockResolvedValueOnce(REFUSED);
    const onAddress = await resendPost(resendRequest({ email: "ada@seed.lombakita.local" }));

    expect(await onIp.text()).toBe(await onAddress.text());
  });
});
