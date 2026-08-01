import { describe, expect, it } from "vitest";
import { detectFileFamily, detectFileType } from "./file-signature";

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

  // The identity-document flow must accept exactly four formats. detectFileFamily recognises more,
  // so this pins the narrowing rather than leaving it to the type system alone.
  it("returns null for families outside the identity-document set", () => {
    expect(detectFileType(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
    expect(detectFileType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBeNull();
    expect(
      detectFileType(bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32)),
    ).toBeNull();
  });
});

describe("detectFileFamily", () => {
  it("detects a zip container, which every OOXML Office file also is", () => {
    expect(detectFileFamily(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBe("application/zip");
  });

  it("detects an empty zip archive", () => {
    expect(detectFileFamily(bytes(0x50, 0x4b, 0x05, 0x06, 0x00, 0x00))).toBe("application/zip");
  });

  it("detects GIF87a and GIF89a", () => {
    expect(detectFileFamily(bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61))).toBe("image/gif");
    expect(detectFileFamily(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
  });

  it("rejects a GIF8 prefix with an invalid version byte", () => {
    expect(detectFileFamily(bytes(0x47, 0x49, 0x46, 0x38, 0x35, 0x61))).toBeNull();
  });

  it("detects MP4 by the ftyp box at offset 4, whatever the leading size bytes are", () => {
    expect(
      detectFileFamily(
        bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32),
      ),
    ).toBe("video/mp4");
  });

  it("still recognises the four identity-document formats", () => {
    expect(detectFileFamily(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe("application/pdf");
    expect(detectFileFamily(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  });

  it("returns null for HTML, which has no signature and must never be accepted", () => {
    expect(
      detectFileFamily(bytes(0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45)),
    ).toBeNull();
    expect(detectFileFamily(bytes(0x3c, 0x73, 0x76, 0x67, 0x20))).toBeNull();
  });
});
