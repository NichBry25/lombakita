import { describe, expect, it } from "vitest";
import {
  familyMatchesFileName,
  getSubmissionFileExtension,
  preValidateSubmissionFile,
  SUBMISSION_ACCEPT_ATTRIBUTE,
  SUBMISSION_MAX_BYTES,
  submissionMimeTypeForFileName,
} from "@/lib/submissions/submission-file";

describe("getSubmissionFileExtension", () => {
  it("lowercases and strips the dot", () => {
    expect(getSubmissionFileExtension("Entry.PDF")).toBe("pdf");
  });

  it("takes the last extension of a multi-dot name", () => {
    expect(getSubmissionFileExtension("archive.tar.gz")).toBe("gz");
  });

  it("ignores directory components in a crafted name", () => {
    expect(getSubmissionFileExtension("../../etc/passwd.pdf")).toBe("pdf");
  });

  it("returns empty for a name with no extension or a trailing dot", () => {
    expect(getSubmissionFileExtension("README")).toBe("");
    expect(getSubmissionFileExtension("trailing.")).toBe("");
    expect(getSubmissionFileExtension(".gitignore")).toBe("");
  });
});

describe("submissionMimeTypeForFileName", () => {
  it("maps each Office extension to its specific type, not the generic zip", () => {
    expect(submissionMimeTypeForFileName("deck.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(submissionMimeTypeForFileName("data.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(submissionMimeTypeForFileName("bundle.zip")).toBe("application/zip");
  });

  it("returns null for a format with no confirmable signature", () => {
    expect(submissionMimeTypeForFileName("index.html")).toBeNull();
    expect(submissionMimeTypeForFileName("logo.svg")).toBeNull();
    expect(submissionMimeTypeForFileName("script.js")).toBeNull();
    expect(submissionMimeTypeForFileName("notes.txt")).toBeNull();
  });
});

describe("familyMatchesFileName", () => {
  // The signature only ever proves the container. Every OOXML format must therefore be accepted
  // for one zip signature, or no Office file could be uploaded at all.
  it("accepts every zip-family extension for a zip signature", () => {
    for (const name of ["bundle.zip", "report.docx", "deck.pptx", "data.xlsx"]) {
      expect(familyMatchesFileName(name, "application/zip")).toBe(true);
    }
  });

  it("rejects a name whose extension belongs to a different family", () => {
    expect(familyMatchesFileName("report.pdf", "application/zip")).toBe(false);
    expect(familyMatchesFileName("bundle.zip", "application/pdf")).toBe(false);
    expect(familyMatchesFileName("photo.png", "image/jpeg")).toBe(false);
  });

  it("rejects a name outside the allowlist entirely", () => {
    expect(familyMatchesFileName("payload.html", "application/zip")).toBe(false);
  });
});

describe("preValidateSubmissionFile", () => {
  it("passes an accepted format within the ceiling", () => {
    expect(preValidateSubmissionFile({ name: "entry.pdf", size: 1024 })).toBeNull();
  });

  it("rejects an unsupported format and names the ZIP escape hatch", () => {
    const message = preValidateSubmissionFile({ name: "index.html", size: 1024 });
    expect(message).toContain("ZIP");
  });

  it("rejects a file over the ceiling", () => {
    expect(
      preValidateSubmissionFile({ name: "entry.pdf", size: SUBMISSION_MAX_BYTES + 1 }),
    ).toContain("50 MB");
  });

  it("rejects an empty file", () => {
    expect(preValidateSubmissionFile({ name: "entry.pdf", size: 0 })).not.toBeNull();
  });
});

describe("SUBMISSION_ACCEPT_ATTRIBUTE", () => {
  it("lists dotted extensions and excludes scriptable formats", () => {
    expect(SUBMISSION_ACCEPT_ATTRIBUTE).toContain(".pdf");
    expect(SUBMISSION_ACCEPT_ATTRIBUTE).toContain(".zip");
    expect(SUBMISSION_ACCEPT_ATTRIBUTE).not.toContain(".html");
    expect(SUBMISSION_ACCEPT_ATTRIBUTE).not.toContain(".svg");
  });
});
