import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/config/env.server";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/registration-code");

export const REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000;

export const issueRegistrationCode = (): string => {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
};

// Keyed with the server secret because a plain hash of a 6-digit code is reversed by hashing all
// million codes, so a reader of the database could recover a live code.
export const hashRegistrationCode = (userId: string, code: string): string => {
  const secret = serverEnv.authSecret;
  if (!secret) {
    throw new Error("registration_code_secret_missing");
  }
  return createHmac("sha256", secret).update(`${userId}:${code}`).digest("hex");
};

export const registrationCodeMatches = (
  storedHash: string,
  userId: string,
  code: string,
): boolean => {
  const expected = Buffer.from(hashRegistrationCode(userId, code));
  const stored = Buffer.from(storedHash);
  if (stored.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(stored, expected);
};
