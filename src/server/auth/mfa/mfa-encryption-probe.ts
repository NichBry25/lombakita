import { serverEnv } from "@/config/env.server";
import { verifyMfaEncryptionRoundTrip } from "@/server/auth/mfa/mfa-encryption";

export const isMfaEncryptionConfigured = (): boolean => {
  return Boolean(serverEnv.mfaSecretEncryptionKey);
};

// A round-trip check, not a presence check — every R2 fault in this project's history was a
// non-empty wrong value sailing through a check that only asked "is something there". Encrypts and
// decrypts a fixed fixture and fails on any mismatch (wrong key length, corrupted value, wrong key
// entirely), which a presence check on MFA_SECRET_ENCRYPTION_KEY could never catch.
export const probeMfaEncryption = async (): Promise<void> => {
  verifyMfaEncryptionRoundTrip();
};
