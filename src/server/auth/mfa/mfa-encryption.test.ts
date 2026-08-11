// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALID_KEY = Buffer.alloc(32, 9).toString("base64");

vi.mock("@/config/env.server", () => ({
  serverEnv: { mfaSecretEncryptionKey: undefined as string | undefined },
}));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { serverEnv } from "@/config/env.server";

const setKey = (value: string | undefined) => {
  (serverEnv as { mfaSecretEncryptionKey?: string }).mfaSecretEncryptionKey = value;
};

describe("mfa-encryption", () => {
  beforeEach(() => {
    vi.resetModules();
    setKey(VALID_KEY);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("round-trips a secret through encrypt then decrypt", async () => {
    const { encryptMfaSecret, decryptMfaSecret } = await import("./mfa-encryption");
    const plaintext = Buffer.from("a totp secret, 20 bytes long!!");

    const encrypted = encryptMfaSecret(plaintext);
    const decrypted = decryptMfaSecret(encrypted);

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("draws a fresh IV on every call, so two encryptions of the same plaintext differ", async () => {
    const { encryptMfaSecret } = await import("./mfa-encryption");
    const plaintext = Buffer.from("same secret");

    const first = encryptMfaSecret(plaintext);
    const second = encryptMfaSecret(plaintext);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("throws MfaEncryptionKeyError when the key is not configured", async () => {
    setKey(undefined);
    const { encryptMfaSecret, MfaEncryptionKeyError } = await import("./mfa-encryption");

    expect(() => encryptMfaSecret(Buffer.from("x"))).toThrow(MfaEncryptionKeyError);
  });

  it("throws MfaEncryptionKeyError when the key does not decode to 32 bytes", async () => {
    setKey(Buffer.alloc(16).toString("base64"));
    const { encryptMfaSecret, MfaEncryptionKeyError } = await import("./mfa-encryption");

    expect(() => encryptMfaSecret(Buffer.from("x"))).toThrow(MfaEncryptionKeyError);
  });

  it("refuses to decrypt when the auth tag has been tampered with", async () => {
    const { encryptMfaSecret, decryptMfaSecret } = await import("./mfa-encryption");
    const encrypted = encryptMfaSecret(Buffer.from("secret bytes"));

    const tampered = {
      ...encrypted,
      authTag: Buffer.from(
        Buffer.from(encrypted.authTag, "base64").map((byte, index) => (index === 0 ? byte ^ 0xff : byte)),
      ).toString("base64"),
    };

    expect(() => decryptMfaSecret(tampered)).toThrow();
  });

  it("refuses to decrypt when the ciphertext has been tampered with", async () => {
    const { encryptMfaSecret, decryptMfaSecret } = await import("./mfa-encryption");
    const encrypted = encryptMfaSecret(Buffer.from("secret bytes, long enough"));

    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from(
        Buffer.from(encrypted.ciphertext, "base64").map((byte, index) => (index === 0 ? byte ^ 0xff : byte)),
      ).toString("base64"),
    };

    expect(() => decryptMfaSecret(tampered)).toThrow();
  });

  it("refuses to decrypt under a different key than it was encrypted with", async () => {
    const { encryptMfaSecret } = await import("./mfa-encryption");
    const encrypted = encryptMfaSecret(Buffer.from("secret bytes"));

    vi.resetModules();
    setKey(Buffer.alloc(32, 42).toString("base64"));
    const reloaded = await import("./mfa-encryption");

    expect(() => reloaded.decryptMfaSecret(encrypted)).toThrow();
  });

  it("verifyMfaEncryptionRoundTrip succeeds with a valid key and throws without one", async () => {
    const { verifyMfaEncryptionRoundTrip } = await import("./mfa-encryption");
    expect(() => verifyMfaEncryptionRoundTrip()).not.toThrow();

    vi.resetModules();
    setKey(undefined);
    const reloaded = await import("./mfa-encryption");
    expect(() => reloaded.verifyMfaEncryptionRoundTrip()).toThrow(reloaded.MfaEncryptionKeyError);
  });
});
