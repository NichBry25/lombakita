// @vitest-environment node
//
// CLASS C in the guard taxonomy: the tenant gate runs at the route, before a service that takes the
// resolved institution as a parameter and opens no transaction of its own. So the detector for both
// a removal and a MOVE is the same and it is sufficient — the service must not have been called.
// There is no rollback here to hide a write that already happened.
//
// The gate is OWNER-ONLY rather than owner-or-staff, which is the substantive access decision on
// this endpoint and is asserted directly: a staff member of the very same institution is refused.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { PaymentInstructionsError } from "@/server/institutions/payment-instructions-service";

const {
  requireAuthenticatedSession,
  assertSessionMatchesExpectedUser,
  requireOwnerInstitutionBySlug,
  loadPaymentInstructionsForInstitution,
  savePaymentInstructions,
  getDb,
} = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  assertSessionMatchesExpectedUser: vi.fn(),
  requireOwnerInstitutionBySlug: vi.fn(),
  loadPaymentInstructionsForInstitution: vi.fn(),
  savePaymentInstructions: vi.fn(),
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
  return { ...actual, loadPaymentInstructionsForInstitution, savePaymentInstructions };
});

import { GET, PUT } from "./route";

const OWNER = {
  user: { id: "owner_1", role: "recruiter", email: "o@example.test" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const context = { params: Promise.resolve({ institutionSlug: "seed-academy" }) };

const putRequest = (body: Record<string, unknown>): Request =>
  new Request("http://localhost/api/v1/institutions/seed-academy/payment-instructions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const COMPLETE = {
  bankName: "Bank Mandiri",
  accountNumber: "1370012345678",
  accountHolderName: "Yayasan Seed Academy",
};

describe("PUT …/payment-instructions", () => {
  afterEach(() => vi.resetAllMocks());

  it("saves against the institution resolved from the slug, not one the caller named", async () => {
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    savePaymentInstructions.mockResolvedValue({ id: "pi_1" });

    // The body names a DIFFERENT institution. Honouring it would let any owner publish their own
    // account number as another institution's, and collect that institution's registrations.
    const response = await PUT(putRequest({ ...COMPLETE, institutionId: "inst_b" }), context);

    expect(response.status).toBe(200);
    expect(requireOwnerInstitutionBySlug).toHaveBeenCalledWith("owner_1", "seed-academy", {});
    expect(savePaymentInstructions).toHaveBeenCalledWith(
      "inst_a",
      expect.objectContaining({ accountNumber: "1370012345678" }),
      {},
    );
  });

  it("WRITES NOTHING for a STAFF member of the same institution", async () => {
    // The separation-of-duties boundary, and the one thing owner-only buys that owner-or-staff does
    // not. Staff already decide whether a transfer arrived; this endpoint decides where transfers
    // go, and one person holding both can redirect money and then confirm it as received.
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner access required"),
    );

    expect((await PUT(putRequest(COMPLETE), context)).status).toBe(403);
    expect(savePaymentInstructions).not.toHaveBeenCalled();
  });

  it("WRITES NOTHING for an owner of a DIFFERENT institution", async () => {
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner access required"),
    );

    expect((await PUT(putRequest(COMPLETE), context)).status).toBe(403);
    expect(savePaymentInstructions).not.toHaveBeenCalled();
  });

  it("WRITES NOTHING for an unauthenticated caller", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, "no"));

    expect((await PUT(putRequest(COMPLETE), context)).status).toBe(401);
    expect(requireOwnerInstitutionBySlug).not.toHaveBeenCalled();
    expect(savePaymentInstructions).not.toHaveBeenCalled();
  });

  it("WRITES NOTHING when the browser session flipped under the form", async () => {
    // Rule 16. On this endpoint the race is not an abstract one: the form was filled in by one
    // owner and would land on whichever institution the cookie now belongs to.
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    assertSessionMatchesExpectedUser.mockImplementation(() => {
      throw new AccessError("session_user_mismatch", 409, "session changed");
    });

    expect((await PUT(putRequest(COMPLETE), context)).status).toBe(409);
    expect(requireOwnerInstitutionBySlug).not.toHaveBeenCalled();
    expect(savePaymentInstructions).not.toHaveBeenCalled();
  });

  it("surfaces incomplete instructions as the service's refusal, in Indonesian", async () => {
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    savePaymentInstructions.mockRejectedValue(
      new PaymentInstructionsError(
        "payment_instructions_incomplete",
        "Isi nama bank, nomor rekening, dan nama pemilik rekening — atau unggah QRIS",
      ),
    );

    const response = await PUT(putRequest({ bankName: "Bank Mandiri" }), context);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("payment_instructions_incomplete");
    expect(body.error.message).toContain("atau unggah QRIS");
  });

  it("surfaces a foreign QRIS key as the service's refusal", async () => {
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    savePaymentInstructions.mockRejectedValue(
      new PaymentInstructionsError(
        "payment_instructions_qris_key_invalid",
        "Berkas QRIS tidak tersimpan di ruang penyimpanan institusi ini",
      ),
    );

    expect(
      (await PUT(putRequest({ ...COMPLETE, qrisR2Key: "payment-instructions/inst_b/x" }), context))
        .status,
    ).toBe(422);
  });
});

describe("GET …/payment-instructions", () => {
  afterEach(() => vi.resetAllMocks());

  it("reads the institution resolved from the slug", async () => {
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    loadPaymentInstructionsForInstitution.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/x"), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ instructions: null });
    expect(loadPaymentInstructionsForInstitution).toHaveBeenCalledWith("inst_a", {});
  });

  it("READS NOTHING for a caller who does not own the institution", async () => {
    // A read matters here too: the account number is the institution's banking detail, and the
    // instructions row is the only place it is legible in full.
    requireAuthenticatedSession.mockResolvedValue(OWNER);
    requireOwnerInstitutionBySlug.mockRejectedValue(
      new AccessError("forbidden", 403, "institution_owner access required"),
    );

    expect((await GET(new Request("http://localhost/x"), context)).status).toBe(403);
    expect(loadPaymentInstructionsForInstitution).not.toHaveBeenCalled();
  });
});
