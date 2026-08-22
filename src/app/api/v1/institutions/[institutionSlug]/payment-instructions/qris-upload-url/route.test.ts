// @vitest-environment node
//
// The upload grant. Class C again (the gate precedes a service that opens no transaction) so
// "the grant was never minted" is a sufficient detector for both removal and move.
//
// The claim that matters beyond access: the caller supplies a FILE NAME and nothing else. There is
// no request field naming a key, a prefix or an institution, so no request can aim an upload at
// another institution's storage even before the service's own prefix check runs.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { PaymentInstructionsError } from "@/server/institutions/payment-instructions-service";

const {
  requireAuthenticatedSession,
  assertSessionMatchesExpectedUser,
  requireOwnerInstitutionBySlug,
  generateQrisUploadUrl,
  getDb,
} = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  assertSessionMatchesExpectedUser: vi.fn(),
  requireOwnerInstitutionBySlug: vi.fn(),
  generateQrisUploadUrl: vi.fn(),
  getDb: vi.fn(() => ({}) as never),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/db/client", () => ({ getDb }));
vi.mock("@/server/institution-members/member-service", () => ({ requireOwnerInstitutionBySlug }));

vi.mock("@/server/auth/access-core", async () => {
  const actual = await vi.importActual<typeof import("@/server/auth/access-core")>(
    "@/server/auth/access-core",
  );
  return { ...actual, assertSessionMatchesExpectedUser };
});

vi.mock("@/server/institutions/payment-instructions-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/institutions/payment-instructions-service")
  >("@/server/institutions/payment-instructions-service");
  return { ...actual, generateQrisUploadUrl };
});

import { POST } from "./route";

const OWNER = {
  user: { id: "owner_1", role: "recruiter", email: "o@example.test" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const context = { params: Promise.resolve({ institutionSlug: "seed-academy" }) };

const uploadRequest = (body: Record<string, unknown>): Request =>
  new Request(
    "http://localhost/api/v1/institutions/seed-academy/payment-instructions/qris-upload-url",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );

describe("POST …/payment-instructions/qris-upload-url", () => {
  afterEach(() => vi.resetAllMocks());

  it("mints a grant for the institution resolved from the slug, ignoring any key the caller sends", async () => {
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    generateQrisUploadUrl.mockResolvedValue({
      uploadUrl: "https://r2.example/put",
      r2Key: "payment-instructions/inst_a/uuid",
      contentType: "image/png",
      expiresAt: new Date(),
    });

    const response = await POST(
      uploadRequest({
        fileName: "qris.png",
        // Every one of these is a field an attacker would reach for, and none is read.
        r2Key: "payment-instructions/inst_b/steal",
        institutionId: "inst_b",
        prefix: "payment-instructions/inst_b/",
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(generateQrisUploadUrl).toHaveBeenCalledWith("inst_a", { fileName: "qris.png" });
    // The service takes exactly two arguments, neither of which can carry a foreign prefix.
    expect(generateQrisUploadUrl.mock.calls[0]).toHaveLength(2);
  });

  it("MINTS NOTHING for a caller who does not own the institution", async () => {
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner access required"),
    );

    expect((await POST(uploadRequest({ fileName: "qris.png" }), context)).status).toBe(403);
    expect(generateQrisUploadUrl).not.toHaveBeenCalled();
  });

  it("MINTS NOTHING for an unauthenticated caller", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, "no"));

    expect((await POST(uploadRequest({ fileName: "qris.png" }), context)).status).toBe(401);
    expect(requireOwnerInstitutionBySlug).not.toHaveBeenCalled();
    expect(generateQrisUploadUrl).not.toHaveBeenCalled();
  });

  it("MINTS NOTHING when the browser session flipped under the form", async () => {
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    assertSessionMatchesExpectedUser.mockImplementation(() => {
      throw new AccessError("session_user_mismatch", 409, "session changed");
    });

    expect((await POST(uploadRequest({ fileName: "qris.png" }), context)).status).toBe(409);
    expect(generateQrisUploadUrl).not.toHaveBeenCalled();
  });

  it("surfaces an unsupported format as a refusal naming the accepted ones, in Indonesian", async () => {
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    generateQrisUploadUrl.mockRejectedValue(
      new PaymentInstructionsError(
        "payment_instructions_qris_format_unsupported",
        "Format tidak didukung. Unggah QRIS dalam format PNG, JPG, atau WEBP.",
      ),
    );

    const response = await POST(uploadRequest({ fileName: "qris.pdf" }), context);
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(422);
    expect(body.error.message).toContain("PNG, JPG, atau WEBP");
  });

  it("surfaces an object-store outage as a refusal, not a crash", async () => {
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    generateQrisUploadUrl.mockRejectedValue(
      new PaymentInstructionsError(
        "payment_instructions_upload_unavailable",
        "Penyimpanan berkas belum dikonfigurasi sehingga unggahan QRIS sementara tidak tersedia",
        503,
      ),
    );

    expect((await POST(uploadRequest({ fileName: "qris.png" }), context)).status).toBe(503);
  });
});
