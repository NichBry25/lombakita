import { describe, expect, it } from "vitest";
import {
  buildContentDisposition,
  extensionMatchesMimeType,
  formatVerificationDownloadName,
  getFileExtension,
  isAllowedDocumentMimeType,
  mimeTypeForExtension,
  preValidateVerificationDocument,
  sanitizeFileName,
  VERIFICATION_DOCUMENT_MAX_BYTES,
} from "./verification-document";

describe("getFileExtension", () => {
  it("returns the lowercased extension without the dot", () => {
    expect(getFileExtension("Letter.PDF")).toBe("pdf");
  });
  it("ignores path components", () => {
    expect(getFileExtension("../../etc/passwd.png")).toBe("png");
  });
  it("returns empty for a dotfile or no extension", () => {
    expect(getFileExtension(".gitignore")).toBe("");
    expect(getFileExtension("noext")).toBe("");
  });
});

describe("mimeTypeForExtension / isAllowedDocumentMimeType", () => {
  it("maps allowed extensions to their canonical MIME type", () => {
    expect(mimeTypeForExtension("pdf")).toBe("application/pdf");
    expect(mimeTypeForExtension("jpg")).toBe("image/jpeg");
    expect(mimeTypeForExtension("jpeg")).toBe("image/jpeg");
    expect(mimeTypeForExtension("png")).toBe("image/png");
    expect(mimeTypeForExtension("webp")).toBe("image/webp");
  });
  it("rejects a dangerous or unknown extension", () => {
    expect(mimeTypeForExtension("svg")).toBeNull();
    expect(mimeTypeForExtension("html")).toBeNull();
    expect(mimeTypeForExtension("exe")).toBeNull();
  });
  it("accepts only allowlisted MIME types", () => {
    expect(isAllowedDocumentMimeType("application/pdf")).toBe(true);
    expect(isAllowedDocumentMimeType("image/svg+xml")).toBe(false);
    expect(isAllowedDocumentMimeType("text/html")).toBe(false);
  });
});

describe("extensionMatchesMimeType", () => {
  it("passes when extension and detected type agree", () => {
    expect(extensionMatchesMimeType("proof.pdf", "application/pdf")).toBe(true);
    expect(extensionMatchesMimeType("id.jpeg", "image/jpeg")).toBe(true);
  });
  it("fails when a PDF extension carries image bytes (or vice versa)", () => {
    expect(extensionMatchesMimeType("proof.pdf", "image/png")).toBe(false);
    expect(extensionMatchesMimeType("proof.png", "application/pdf")).toBe(false);
  });
});

describe("sanitizeFileName", () => {
  it("strips path separators and header-unsafe characters", () => {
    expect(sanitizeFileName("../../foo/bar.pdf")).toBe("bar.pdf");
    expect(sanitizeFileName('bad"name\r\n.pdf')).toBe("bad_name_.pdf");
  });
  it("never returns an empty string", () => {
    expect(sanitizeFileName("///")).toBe("dokumen");
  });
});

describe("formatVerificationDownloadName", () => {
  it("builds <username>_verification_<name>", () => {
    expect(formatVerificationDownloadName("rendra", "Surat Tugas.pdf")).toBe(
      "rendra_verification_Surat_Tugas.pdf",
    );
  });
  it("falls back to 'rekruter' when the username is null", () => {
    expect(formatVerificationDownloadName(null, "id.png")).toBe("rekruter_verification_id.png");
  });
  it("neutralizes header-injection attempts in the original name", () => {
    const result = formatVerificationDownloadName("rendra", 'x"\r\nSet-Cookie: y.pdf');
    expect(result).not.toContain("\r");
    expect(result).not.toContain("\n");
    expect(result).not.toContain('"');
  });
});

describe("buildContentDisposition", () => {
  it("emits an ASCII fallback plus an RFC 5987 UTF-8 form", () => {
    const value = buildContentDisposition("attachment", "résumé.pdf");
    expect(value.startsWith("attachment; filename=")).toBe(true);
    expect(value).toContain("filename*=UTF-8''");
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
  });
});

describe("preValidateVerificationDocument", () => {
  it("accepts an allowed file within the size cap", () => {
    expect(
      preValidateVerificationDocument({ name: "proof.pdf", type: "application/pdf", size: 1000 }),
    ).toBeNull();
  });
  it("rejects a disallowed extension", () => {
    expect(
      preValidateVerificationDocument({ name: "x.svg", type: "image/svg+xml", size: 10 }),
    ).toMatch(/Format tidak didukung/);
  });
  it("rejects a declared type that disagrees with the extension", () => {
    expect(preValidateVerificationDocument({ name: "x.pdf", type: "image/png", size: 10 })).toMatch(
      /tidak cocok/,
    );
  });
  it("rejects an oversize file", () => {
    expect(
      preValidateVerificationDocument({
        name: "x.pdf",
        type: "application/pdf",
        size: VERIFICATION_DOCUMENT_MAX_BYTES + 1,
      }),
    ).toMatch(/10 MB/);
  });
  it("rejects an empty file", () => {
    expect(
      preValidateVerificationDocument({ name: "x.pdf", type: "application/pdf", size: 0 }),
    ).toMatch(/kosong/);
  });
});
