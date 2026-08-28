// @vitest-environment node
//
// RFC 4648 test vectors (§10), padding stripped from the expected values since base32Encode is
// deliberately unpadded (the form every otpauth:// URI and authenticator app expects).

import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, Base32DecodeError } from "./base32";

const VECTORS: Array<[string, string]> = [
  ["", ""],
  ["f", "MY"],
  ["fo", "MZXQ"],
  ["foo", "MZXW6"],
  ["foob", "MZXW6YQ"],
  ["fooba", "MZXW6YTB"],
  ["foobar", "MZXW6YTBOI"],
];

describe("base32Encode", () => {
  it.each(VECTORS)("encodes %j as %s (RFC 4648 §10, unpadded)", (input, expected) => {
    expect(base32Encode(Buffer.from(input, "ascii"))).toBe(expected);
  });
});

describe("base32Decode", () => {
  // The empty-input vector is excluded here: base32Decode deliberately REJECTS an empty string
  // (see the "rejects an empty string" test below) rather than returning an empty buffer — there is
  // no legitimate empty TOTP secret, so treating it as invalid input is the safer default.
  it.each(VECTORS.filter(([, encoded]) => encoded.length > 0))(
    "decodes %s back to %j",
    (expected, encoded) => {
      expect(base32Decode(encoded).toString("ascii")).toBe(expected);
    },
  );

  it("accepts standard padding", () => {
    expect(base32Decode("MZXW6YTBOI======").toString("ascii")).toBe("foobar");
  });

  it("accepts lowercase and surrounding whitespace", () => {
    expect(base32Decode("  mzxw6ytboi  ").toString("ascii")).toBe("foobar");
  });

  it("rejects a character outside the RFC 4648 alphabet", () => {
    expect(() => base32Decode("MZXW6YTB01")).toThrow(Base32DecodeError);
  });

  it("rejects an empty string", () => {
    expect(() => base32Decode("")).toThrow(Base32DecodeError);
  });

  it("round-trips a random 20-byte TOTP-sized secret", () => {
    const secret = Buffer.from(Array.from({ length: 20 }, (_, i) => (i * 37 + 11) % 256));

    expect(base32Decode(base32Encode(secret))).toEqual(secret);
  });
});
