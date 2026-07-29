// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_REGISTRATIONS,
  MAX_REQUEST_TITLE_LENGTH,
  RegistrationDocumentError,
  buildCompetitionObjectPrefix,
  buildRequestObjectPrefix,
  parseBatchDocumentRequestInput,
  parseDeadlineExtensionInput,
  parseDocumentFileFinalizeInput,
  parseDocumentRequestInput,
  parseDocumentReviewInput,
} from "@/server/registration-documents/registration-document-core";
import {
  candidateMayModifyFiles,
  deriveRequestDisplayStatus,
  isOpenRequestStatus,
} from "@/lib/registration-documents/request-status";

const NOW = new Date("2026-02-01T00:00:00.000Z");
const FUTURE = "2026-02-14T00:00:00.000Z";
const PAST = "2026-01-20T00:00:00.000Z";

const expectError = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RegistrationDocumentError);
    expect((error as RegistrationDocumentError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
};

describe("parseDocumentRequestInput", () => {
  it("parses a valid request and trims text", () => {
    const parsed = parseDocumentRequestInput(
      { title: "  Kartu pelajar  ", instructions: "  Pastikan terbaca  ", dueAt: FUTURE },
      NOW,
    );
    expect(parsed.title).toBe("Kartu pelajar");
    expect(parsed.instructions).toBe("Pastikan terbaca");
    expect(parsed.dueAt.toISOString()).toBe(FUTURE);
  });

  it("treats blank instructions as absent", () => {
    const parsed = parseDocumentRequestInput(
      { title: "Kartu pelajar", instructions: "   ", dueAt: FUTURE },
      NOW,
    );
    expect(parsed.instructions).toBeNull();
  });

  it("rejects a non-object body", () => {
    expectError(() => parseDocumentRequestInput("nope", NOW), "document_request_invalid_payload");
  });

  it("rejects a missing title", () => {
    expectError(
      () => parseDocumentRequestInput({ dueAt: FUTURE }, NOW),
      "document_request_invalid_value",
    );
  });

  it("rejects an over-long title", () => {
    expectError(
      () =>
        parseDocumentRequestInput(
          { title: "x".repeat(MAX_REQUEST_TITLE_LENGTH + 1), dueAt: FUTURE },
          NOW,
        ),
      "document_request_invalid_value",
    );
  });

  it("rejects a deadline in the past — a request must not be born already lapsed", () => {
    expectError(
      () => parseDocumentRequestInput({ title: "Kartu pelajar", dueAt: PAST }, NOW),
      "document_request_invalid_value",
    );
  });

  it("rejects an unparseable deadline", () => {
    expectError(
      () => parseDocumentRequestInput({ title: "Kartu pelajar", dueAt: "besok" }, NOW),
      "document_request_invalid_value",
    );
  });
});

describe("parseBatchDocumentRequestInput", () => {
  it("de-duplicates repeated registration ids", () => {
    const parsed = parseBatchDocumentRequestInput(
      { title: "Kartu pelajar", dueAt: FUTURE, registrationIds: ["r1", "r2", "r1"] },
      NOW,
    );
    expect(parsed.registrationIds).toEqual(["r1", "r2"]);
  });

  it("rejects an empty target list", () => {
    expectError(
      () =>
        parseBatchDocumentRequestInput(
          { title: "Kartu pelajar", dueAt: FUTURE, registrationIds: [] },
          NOW,
        ),
      "document_request_invalid_payload",
    );
  });

  it("rejects a batch beyond the cap", () => {
    const registrationIds = Array.from(
      { length: MAX_BATCH_REGISTRATIONS + 1 },
      (_, index) => `r${index}`,
    );
    expectError(
      () =>
        parseBatchDocumentRequestInput(
          { title: "Kartu pelajar", dueAt: FUTURE, registrationIds },
          NOW,
        ),
      "document_request_invalid_value",
    );
  });
});

describe("parseDocumentReviewInput", () => {
  it("accepts without a note", () => {
    expect(parseDocumentReviewInput({ verdict: "accept" }, NOW)).toEqual({
      verdict: "accept",
      note: null,
    });
  });

  it("requires a reason on every rejection", () => {
    expectError(
      () => parseDocumentReviewInput({ verdict: "reject", allowReupload: false }, NOW),
      "document_request_invalid_value",
    );
  });

  it("closes the request when re-upload is not allowed", () => {
    expect(
      parseDocumentReviewInput(
        { verdict: "reject", note: "Dokumen dipalsukan.", allowReupload: false },
        NOW,
      ),
    ).toEqual({ verdict: "reject", note: "Dokumen dipalsukan.", allowReupload: false });
  });

  it("requires a fresh deadline when re-upload is allowed", () => {
    expectError(
      () =>
        parseDocumentReviewInput(
          { verdict: "reject", note: "Foto buram.", allowReupload: true },
          NOW,
        ),
      "document_request_invalid_value",
    );
  });

  it("parses a reopening rejection with its new deadline", () => {
    expect(
      parseDocumentReviewInput(
        { verdict: "reject", note: "Foto buram.", allowReupload: true, dueAt: FUTURE },
        NOW,
      ),
    ).toEqual({
      verdict: "reject",
      note: "Foto buram.",
      allowReupload: true,
      dueAt: new Date(FUTURE),
    });
  });

  it("rejects an unknown verdict", () => {
    expectError(
      () => parseDocumentReviewInput({ verdict: "waitlist" }, NOW),
      "document_request_invalid_value",
    );
  });
});

describe("parseDeadlineExtensionInput", () => {
  it("parses a future deadline", () => {
    expect(parseDeadlineExtensionInput({ dueAt: FUTURE }, NOW).toISOString()).toBe(FUTURE);
  });

  it("refuses to extend into the past", () => {
    expectError(
      () => parseDeadlineExtensionInput({ dueAt: PAST }, NOW),
      "document_request_invalid_value",
    );
  });
});

describe("parseDocumentFileFinalizeInput", () => {
  it("parses a finalize payload", () => {
    expect(
      parseDocumentFileFinalizeInput({
        r2Key: "registration-documents/r/q/f",
        originalFileName: "a.jpg",
      }),
    ).toEqual({ r2Key: "registration-documents/r/q/f", originalFileName: "a.jpg" });
  });

  it("rejects a missing key", () => {
    expectError(
      () => parseDocumentFileFinalizeInput({ originalFileName: "a.jpg" }),
      "document_request_invalid_value",
    );
  });
});

describe("deriveRequestDisplayStatus", () => {
  const dueAt = new Date("2026-02-14T00:00:00.000Z");
  const beforeDue = new Date("2026-02-10T00:00:00.000Z");
  const afterDue = new Date("2026-02-20T00:00:00.000Z");

  it("shows an open request as requested while the deadline holds", () => {
    expect(
      deriveRequestDisplayStatus({ status: "requested", dueAt, submittedAt: null }, beforeDue),
    ).toEqual({ status: "requested", isOverdue: false, isLate: false });
  });

  it("derives unfulfilled once the deadline passes with nothing uploaded", () => {
    expect(
      deriveRequestDisplayStatus({ status: "requested", dueAt, submittedAt: null }, afterDue),
    ).toEqual({ status: "unfulfilled", isOverdue: true, isLate: false });
  });

  it("marks a late upload as late but still awaiting review", () => {
    expect(
      deriveRequestDisplayStatus({ status: "submitted", dueAt, submittedAt: afterDue }, afterDue),
    ).toEqual({ status: "submitted", isOverdue: false, isLate: true });
  });

  it("does not mark an on-time upload as late", () => {
    expect(
      deriveRequestDisplayStatus({ status: "submitted", dueAt, submittedAt: beforeDue }, afterDue),
    ).toEqual({ status: "submitted", isOverdue: false, isLate: false });
  });

  it("never reports a reviewed request as overdue, however long ago it was due", () => {
    for (const status of ["accepted", "rejected", "cancelled"] as const) {
      expect(
        deriveRequestDisplayStatus({ status, dueAt, submittedAt: beforeDue }, afterDue),
      ).toEqual({ status, isOverdue: false, isLate: false });
    }
  });
});

describe("request status predicates", () => {
  it("treats only requested and submitted as open", () => {
    expect(isOpenRequestStatus("requested")).toBe(true);
    expect(isOpenRequestStatus("submitted")).toBe(true);
    expect(isOpenRequestStatus("accepted")).toBe(false);
    expect(isOpenRequestStatus("rejected")).toBe(false);
    expect(isOpenRequestStatus("cancelled")).toBe(false);
  });

  it("freezes files once a verdict lands, accepted and rejected alike", () => {
    // Open: a photo that cannot be read can still be swapped.
    expect(candidateMayModifyFiles("requested")).toBe(true);
    expect(candidateMayModifyFiles("submitted")).toBe(true);
    // Decided: the document is the evidence the verdict rests on.
    expect(candidateMayModifyFiles("accepted")).toBe(false);
    expect(candidateMayModifyFiles("rejected")).toBe(false);
    expect(candidateMayModifyFiles("cancelled")).toBe(false);
  });
});

describe("object key layout", () => {
  it("scopes a key to one request under one registration under one competition", () => {
    expect(buildRequestObjectPrefix("comp_1", "reg_1", "req_2")).toBe(
      "registration-documents/comp_1/reg_1/req_2/",
    );
  });

  it("nests every request prefix under its competition prefix, so a purge is one subtree", () => {
    // The retention purge deletes by competition prefix. If a request key ever stopped starting
    // with its competition prefix, the purge would silently leave documents behind.
    const competitionPrefix = buildCompetitionObjectPrefix("comp_1");
    const requestPrefix = buildRequestObjectPrefix("comp_1", "reg_1", "req_2");
    expect(requestPrefix.startsWith(competitionPrefix)).toBe(true);
  });

  it("keeps two competitions in disjoint subtrees", () => {
    expect(buildCompetitionObjectPrefix("comp_1")).not.toBe(buildCompetitionObjectPrefix("comp_2"));
    expect(buildRequestObjectPrefix("comp_2", "reg_1", "req_2")).not.toContain("comp_1");
  });
});
