// @vitest-environment node

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hostKeys = vi.hoisted(() => ({
  one: Buffer.alloc(32, 11).toString("base64"),
  two: Buffer.alloc(32, 22).toString("base64"),
  short: Buffer.alloc(16, 1).toString("base64"),
  authSecret: Buffer.alloc(32, 33).toString("base64"),
}));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: {
      ...actual.serverEnv,
      authSecret: hostKeys.authSecret,
      hostIdentityHashKey: hostKeys.one,
    },
  };
});
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { serverEnv } from "@/config/env.server";
import { toDialDigits } from "@/lib/competitions/organizer-contact";
import {
  HostIdentityKeyError,
  hashHostIdentifier,
  hostIdentityKeyCheck,
  matchableEmail,
} from "./removed-host-identity";

const useHostIdentityKey = (value: string | undefined) => {
  (serverEnv as { hostIdentityHashKey?: string }).hostIdentityHashKey = value;
};

const hmacHexUnder = (key: string, text: string): string =>
  createHmac("sha256", Buffer.from(key, "base64")).update(text).digest("hex");

const keyErrorCodeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HostIdentityKeyError);
    return (error as HostIdentityKeyError).code;
  }
  return undefined;
};

describe("the host identity hash", () => {
  beforeEach(() => {
    useHostIdentityKey(hostKeys.one);
  });

  it("hashes an identifier as the HMAC-SHA256 of its kind and value under the key, in lower-case hex", () => {
    const emailHash = hashHostIdentifier("email", "budi@acme.example");
    expect(emailHash).toBe(hmacHexUnder(hostKeys.one, "email:budi@acme.example"));
    expect(emailHash).toHaveLength(64);
    expect(emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashHostIdentifier("phone", "6281234567890")).toBe(
      hmacHexUnder(hostKeys.one, "phone:6281234567890"),
    );
  });

  it("gives two spellings of one address one hash, keeps dots and leaves a leading plus alone", () => {
    expect(matchableEmail(" Budi+Lomba@Acme.example ")).toBe("budi@acme.example");
    expect(matchableEmail("budi.santoso+lomba@acme.example")).toBe("budi.santoso@acme.example");
    expect(matchableEmail("+lomba@acme.example")).toBe("+lomba@acme.example");
    expect(hashHostIdentifier("email", matchableEmail("Budi+lomba@Acme.example"))).toBe(
      hashHostIdentifier("email", matchableEmail("budi@acme.example")),
    );
    expect(toDialDigits("0812-3456-7890")).toBe("6281234567890");
    expect(toDialDigits("+62 812 3456 7890")).toBe("6281234567890");
  });

  it("refuses to hash or make the key check without the key, and never uses AUTH_SECRET in its place", () => {
    useHostIdentityKey(undefined);

    expect(keyErrorCodeOf(() => hashHostIdentifier("email", "budi@acme.example"))).toBe(
      "host_identity_key_missing",
    );
    expect(keyErrorCodeOf(() => hostIdentityKeyCheck())).toBe("host_identity_key_missing");
  });

  it("refuses a key that does not decode to 32 bytes", () => {
    useHostIdentityKey(hostKeys.short);

    expect(keyErrorCodeOf(() => hashHostIdentifier("email", "budi@acme.example"))).toBe(
      "host_identity_key_invalid",
    );
  });

  it("derives the key check from the key alone, so another key gives another check", () => {
    const checkUnderOne = hostIdentityKeyCheck();
    expect(checkUnderOne).toBe(hmacHexUnder(hostKeys.one, "host-identity-key-check"));

    useHostIdentityKey(hostKeys.two);

    expect(hostIdentityKeyCheck()).not.toBe(checkUnderOne);
  });
});
