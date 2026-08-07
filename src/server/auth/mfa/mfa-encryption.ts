import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { serverEnv } from "@/config/env.server";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/mfa/mfa-encryption");

// AES-256-GCM at rest for platform_ops/finance_ops TOTP secrets.
//
// The key comes from MFA_SECRET_ENCRYPTION_KEY (32 raw bytes, base64) and is deliberately NOT
// derived from AUTH_SECRET: AUTH_SECRET rotation is a session-invalidation lever (every JWT signed
// with the old value stops verifying), and deriving the MFA key from it would silently destroy
// every enrolled factor on every rotation — an operator who did nothing wrong would be locked out
// of their own account the next time a compromised session forced a secret rotation.
//
// The key is resolved and validated LAZILY, on first encrypt/decrypt call, not at module import.
// Every other server module in this codebase that needs a secret (oauth-identity-carrier's
// AUTH_SECRET, for one) checks it inside the function that uses it, not at the top of the file —
// throwing at bare import time would crash every request that merely resolves a session (the jwt/
// session callbacks import this module transitively) in any environment that has not yet
// provisioned the key, including local development. Failing loudly still happens: the first actual
// attempt to enrol or verify an MFA factor throws a clear, named error instead of silently
// producing ciphertext nothing can ever decrypt.

export class MfaEncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfaEncryptionKeyError";
  }
}

const KEY_BYTE_LENGTH = 32; // AES-256
const IV_BYTE_LENGTH = 12; // GCM-recommended 96-bit nonce
const ALGORITHM = "aes-256-gcm";

let cachedKey: Buffer | null | undefined;

const resolveEncryptionKey = (): Buffer => {
  if (cachedKey !== undefined) {
    if (cachedKey === null) {
      throw new MfaEncryptionKeyError(
        "MFA_SECRET_ENCRYPTION_KEY is not configured — cannot encrypt or decrypt an MFA secret",
      );
    }
    return cachedKey;
  }

  const raw = serverEnv.mfaSecretEncryptionKey;
  if (!raw) {
    cachedKey = null;
    throw new MfaEncryptionKeyError(
      "MFA_SECRET_ENCRYPTION_KEY is not configured — cannot encrypt or decrypt an MFA secret",
    );
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    cachedKey = null;
    throw new MfaEncryptionKeyError("MFA_SECRET_ENCRYPTION_KEY is not valid base64");
  }

  if (decoded.length !== KEY_BYTE_LENGTH) {
    cachedKey = null;
    throw new MfaEncryptionKeyError(
      `MFA_SECRET_ENCRYPTION_KEY must decode to ${KEY_BYTE_LENGTH} bytes, got ${decoded.length}`,
    );
  }

  cachedKey = decoded;
  return decoded;
};

export type EncryptedMfaSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

// Encrypts a raw TOTP secret. Each call draws a fresh random IV — GCM must never reuse an IV under
// the same key, and a fresh enrolment always calls this exactly once.
export const encryptMfaSecret = (plaintext: Buffer): EncryptedMfaSecret => {
  const key = resolveEncryptionKey();
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
};

// Decrypts a stored secret. Throws on any tamper (GCM auth tag mismatch) or key mismatch — there is
// no partial-success outcome, by design.
export const decryptMfaSecret = (encrypted: EncryptedMfaSecret): Buffer => {
  const key = resolveEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
};

// Round-trip self-test used by the Rule 31 connector probe. Encrypts and decrypts a fixed-shape
// fixture and confirms the plaintext survives — a check that fails on a mismatched or corrupt key,
// not merely on its absence.
export const verifyMfaEncryptionRoundTrip = (): void => {
  const fixture = Buffer.from("mfa-secret-encryption-probe", "utf8");
  const encrypted = encryptMfaSecret(fixture);
  const decrypted = decryptMfaSecret(encrypted);

  if (!decrypted.equals(fixture)) {
    throw new MfaEncryptionKeyError("MFA secret encryption round-trip did not return the original value");
  }
};
