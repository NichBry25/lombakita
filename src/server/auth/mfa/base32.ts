import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/mfa/base32");

// RFC 4648 base32 (the "Base 32 Encoding" used by every TOTP authenticator app). No dependency:
// this is ~30 lines of table lookup, smaller and more auditable than adding a package for it.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CHAR_INDEX = new Map(ALPHABET.split("").map((char, index) => [char, index]));

// No padding — authenticator apps and otpauth:// URIs both expect an unpadded secret.
export const base32Encode = (input: Buffer): string => {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 0x1f];
  }

  return output;
};

export class Base32DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Base32DecodeError";
  }
}

// Accepts padding and mixed case (some authenticator apps display the secret uppercase, some
// operators type it lowercase); rejects any character outside the RFC 4648 alphabet.
export const base32Decode = (input: string): Buffer => {
  const normalized = input.trim().toUpperCase().replace(/=+$/g, "");
  if (normalized.length === 0) {
    throw new Base32DecodeError("Empty base32 input");
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = CHAR_INDEX.get(char);
    if (index === undefined) {
      throw new Base32DecodeError(`Invalid base32 character: ${char}`);
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};
