// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { RecruiterVerificationError } from "@/server/recruiter-verification/recruiter-verification-core";

const { requireSessionRole, assertSessionMatchesExpectedUser, deleteVerificationDocumentForUser } =
  vi.hoisted(() => ({
    requireSessionRole: vi.fn(),
    assertSessionMatchesExpectedUser: vi.fn(),
    deleteVerificationDocumentForUser: vi.fn(),
  }));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));

vi.mock("@/server/auth/access-core", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/access-core")>(
    "@/server/auth/access-core",
  );
  return { ...actual, assertSessionMatchesExpectedUser };
});

vi.mock("@/server/recruiter-verification/recruiter-verification-service", () => ({
  deleteVerificationDocumentForUser,
}));

import { DELETE } from "./route";

const recruiterSession = {
  user: { id: "rec_1", role: "recruiter", email: "rec@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const context = { params: Promise.resolve({ documentId: "doc_1" }) };

const deleteRequest = () =>
  new Request("http://localhost/api/v1/recruiter/me/verification/documents/doc_1", {
    method: "DELETE",
  });

describe("DELETE /api/v1/recruiter/me/verification/documents/[documentId]", () => {
  afterEach(() => vi.clearAllMocks());

  it("deletes the caller's own document and returns 204", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);
    deleteVerificationDocumentForUser.mockResolvedValue(undefined);

    const response = await DELETE(deleteRequest(), context);

    expect(response.status).toBe(204);
    expect(requireSessionRole).toHaveBeenCalledWith(["recruiter"]);
    // Rule #16 — the cross-session guard runs on this owner-scoped mutation.
    expect(assertSessionMatchesExpectedUser).toHaveBeenCalled();
    // The target is always the session's own id, never a client-supplied user.
    expect(deleteVerificationDocumentForUser).toHaveBeenCalledWith("rec_1", "doc_1");
  });

  it("surfaces a document that is unknown or not the caller's as 404", async () => {
    requireSessionRole.mockResolvedValue(recruiterSession);
    deleteVerificationDocumentForUser.mockRejectedValue(
      new RecruiterVerificationError(
        "recruiter_verification_document_not_found",
        "Document not found",
      ),
    );

    const response = await DELETE(deleteRequest(), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "recruiter_verification_document_not_found" },
    });
  });

  it("does not touch the service when the session guard rejects", async () => {
    requireSessionRole.mockRejectedValue(new Error("no session"));

    const response = await DELETE(deleteRequest(), context);

    expect(response.status).toBe(500);
    expect(deleteVerificationDocumentForUser).not.toHaveBeenCalled();
  });
});
