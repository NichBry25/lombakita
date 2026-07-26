import { describe, expect, it } from "vitest";
import { detectFileType } from "./file-signature";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

describe("detectFileType", () => {
  it("detects a PDF by its %PDF- signature", () => {
    expect(detectFileType(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37))).toBe(
      "application/pdf",
    );
  });

  it("detects a JPEG by its FF D8 FF signature", () => {
    expect(detectFileType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("image/jpeg");
  });

  it("detects a PNG by its 8-byte signature", () => {
    expect(detectFileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
  });

  it("detects a WebP by the RIFF/WEBP container tags", () => {
    // "RIFF" .... "WEBP"
    expect(
      detectFileType(bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50)),
    ).toBe("image/webp");
  });

  it("returns null for an unknown signature", () => {
    expect(detectFileType(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull();
  });

  it("returns null for a RIFF container that is not WebP (e.g. WAV)", () => {
    expect(
      detectFileType(bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45)),
    ).toBeNull();
  });

  it("returns null for an empty buffer", () => {
    expect(detectFileType(bytes())).toBeNull();
  });

  it("does not treat a %PDF signature that is not at the start as a PDF", () => {
    expect(detectFileType(bytes(0x0a, 0x25, 0x50, 0x44, 0x46, 0x2d))).toBeNull();
  });
});
