// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  isSubmissionWindowOpen,
  parseSubmissionFileMetadata,
  SubmissionError,
  type ValidatedFileMetadata,
} from "./submission-core";
import { SUBMISSIONS_MAX_FILE_SIZE_BYTES } from "./submission-constants";

const START = new Date("2026-06-01T00:00:00.000Z");
const END = new Date("2026-06-30T00:00:00.000Z");

describe("isSubmissionWindowOpen", () => {
  it("returns false before the window opens", () => {
    expect(
      isSubmissionWindowOpen(
        { eventStartAt: START, eventEndAt: END },
        new Date("2026-05-31T23:59:59.000Z"),
      ),
    ).toBe(false);
  });

  it("returns true inside the window", () => {
    expect(
      isSubmissionWindowOpen(
        { eventStartAt: START, eventEndAt: END },
        new Date("2026-06-15T12:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("returns false after the window closes", () => {
    expect(
      isSubmissionWindowOpen(
        { eventStartAt: START, eventEndAt: END },
        new Date("2026-07-01T00:00:01.000Z"),
      ),
    ).toBe(false);
  });

  it("returns false when eventStartAt is null", () => {
    expect(
      isSubmissionWindowOpen(
        { eventStartAt: null, eventEndAt: END },
        new Date("2026-06-15T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("returns false when eventEndAt is null", () => {
    expect(
      isSubmissionWindowOpen(
        { eventStartAt: START, eventEndAt: null },
        new Date("2026-06-15T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("is inclusive at both boundaries (now === start and now === end)", () => {
    expect(isSubmissionWindowOpen({ eventStartAt: START, eventEndAt: END }, START)).toBe(true);
    expect(isSubmissionWindowOpen({ eventStartAt: START, eventEndAt: END }, END)).toBe(true);
  });
});

describe("parseSubmissionFileMetadata", () => {
  it("accepts valid input and normalizes fields", () => {
    const result = parseSubmissionFileMetadata({
      fileKey: " submissions/comp_1/reg_1/abc ",
      fileName: " report.pdf ",
      fileSizeBytes: 1024,
      fileMimeType: " application/pdf ",
    });
    expect(result).not.toBeInstanceOf(SubmissionError);
    const meta = result as ValidatedFileMetadata;
    expect(meta.fileKey).toBe("submissions/comp_1/reg_1/abc");
    expect(meta.fileName).toBe("report.pdf");
    expect(meta.fileSizeBytes).toBe(1024);
    // A declared MIME is accepted and dropped: the stored type comes from the confirmed bytes.
    expect(meta).not.toHaveProperty("fileMimeType");
  });

  it("defaults optional fields to null when omitted", () => {
    const result = parseSubmissionFileMetadata({
      fileKey: "submissions/comp_1/reg_1/abc",
      fileName: "report.pdf",
    });
    const meta = result as ValidatedFileMetadata;
    expect(meta.fileSizeBytes).toBeNull();
  });

  it("rejects a blank fileKey with submission_invalid_file_key", () => {
    const result = parseSubmissionFileMetadata({ fileKey: "   ", fileName: "report.pdf" });
    expect(result).toBeInstanceOf(SubmissionError);
    expect((result as SubmissionError).code).toBe("submission_invalid_file_key");
  });

  it("rejects a missing fileName with submission_invalid_payload", () => {
    const result = parseSubmissionFileMetadata({ fileKey: "submissions/comp_1/reg_1/abc" });
    expect(result).toBeInstanceOf(SubmissionError);
    expect((result as SubmissionError).code).toBe("submission_invalid_payload");
  });

  it("rejects a file size over the ceiling", () => {
    const result = parseSubmissionFileMetadata({
      fileKey: "submissions/comp_1/reg_1/abc",
      fileName: "big.zip",
      fileSizeBytes: SUBMISSIONS_MAX_FILE_SIZE_BYTES + 1,
    });
    expect(result).toBeInstanceOf(SubmissionError);
    expect((result as SubmissionError).code).toBe("submission_invalid_payload");
  });
});
