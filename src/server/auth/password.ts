import { createHash, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/password");

const scryptAsync = promisify(scrypt);

const PASSWORD_HASH_VERSION = "s1";
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

export class PasswordValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const ensurePasswordShape = (password: string): string => {
  const normalized = password.trim();

  if (normalized.length < MIN_PASSWORD_LENGTH || normalized.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordValidationError(
      "Password must be between 8 and 72 characters after trimming",
    );
  }

  return normalized;
};

export const hashPassword = async (password: string): Promise<string> => {
  const normalizedPassword = ensurePasswordShape(password);
  const salt = randomBytes(PASSWORD_SALT_BYTES).toString("hex");
  const derivedKey = (await scryptAsync(normalizedPassword, salt, PASSWORD_KEY_LENGTH)) as Buffer;

  return `${PASSWORD_HASH_VERSION}$${salt}$${derivedKey.toString("hex")}`;
};

const parseHashPayload = (passwordHash: string): { salt: string; digest: Buffer } | null => {
  const [version, salt, digestHex] = passwordHash.split("$");

  if (version !== PASSWORD_HASH_VERSION || !salt || !digestHex) {
    return null;
  }

  if (!/^[a-f0-9]+$/i.test(salt) || !/^[a-f0-9]+$/i.test(digestHex)) {
    return null;
  }

  return {
    salt,
    digest: Buffer.from(digestHex, "hex"),
  };
};

export const verifyPassword = async (password: string, passwordHash: string): Promise<boolean> => {
  const hashPayload = parseHashPayload(passwordHash);

  if (!hashPayload) {
    return false;
  }

  const derivedKey = (await scryptAsync(
    password,
    hashPayload.salt,
    hashPayload.digest.length,
  )) as Buffer;

  if (derivedKey.length !== hashPayload.digest.length) {
    return false;
  }

  return timingSafeEqual(derivedKey, hashPayload.digest);
};

export const hashVerificationToken = (rawToken: string): string => {
  return createHash("sha256").update(rawToken).digest("hex");
};

export const issueVerificationToken = (): { rawToken: string; tokenHash: string } => {
  const rawToken = randomBytes(32).toString("hex");

  return {
    rawToken,
    tokenHash: hashVerificationToken(rawToken),
  };
};
