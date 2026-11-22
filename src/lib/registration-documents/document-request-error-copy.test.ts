import { describe, expect, it } from "vitest";
import { resolveDocumentRequestErrorMessage } from "./document-request-error-copy";

describe("resolveDocumentRequestErrorMessage", () => {
  it("returns the copy for a code that has one", () => {
    const message = resolveDocumentRequestErrorMessage("document_request_not_found", "Fallback.");

    expect(message).toBe("Permintaan tidak ditemukan. Muat ulang halaman lalu coba lagi.");
  });

  it("returns the fallback for a code without copy", () => {
    const message = resolveDocumentRequestErrorMessage(
      "document_request_file_too_large",
      "Fallback.",
    );

    expect(message).toBe("Fallback.");
  });

  it("returns the fallback when there is no code", () => {
    const message = resolveDocumentRequestErrorMessage(undefined, "Fallback.");

    expect(message).toBe("Fallback.");
  });
});
