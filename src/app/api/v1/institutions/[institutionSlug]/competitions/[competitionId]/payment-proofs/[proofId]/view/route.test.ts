// @vitest-environment node
//
// Looking at a candidate's bank receipt is itself a recorded act, so the assertions here are about
// ORDER: nothing is minted and nothing is audited until the caller is known to administer the
// institution named in the path.
//
// The scoping of the proof lookup, and the fact that the audit row is written only after that
// lookup resolves, live in the service and are proven against a real database. What this file
// proves is the wiring above it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { ManualProofError } from "@/server/finance/manual-payment-proof-service";

const {
  requireAuthenticatedSession,
  requireAdminInstitutionBySlug,
  generateManualProofViewUrl,
  getDb,
} = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  requireAdminInstitutionBySlug: vi.fn(),
  generateManualProofViewUrl: vi.fn(),
  getDb: vi.fn(() => ({}) as never),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/db/client", () => ({ getDb }));
vi.mock("@/server/institution-members/member-service", () => ({ requireAdminInstitutionBySlug }));

vi.mock("@/server/finance/manual-payment-proof-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/finance/manual-payment-proof-service")
  >("@/server/finance/manual-payment-proof-service");
  return { ...actual, generateManualProofViewUrl };
});

import { POST } from "./route";

const ORGANISER = {
  user: { id: "org_1", role: "recruiter", email: "o@example.test" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const context = {
  params: Promise.resolve({
    institutionSlug: "panitia-a",
    competitionId: "comp_1",
    proofId: "proof_1",
  }),
};

const viewRequest = (): Request =>
  new Request(
    "http://localhost/api/v1/institutions/panitia-a/competitions/comp_1/payment-proofs/proof_1/view",
    { method: "POST" },
  );

describe("POST …/payment-proofs/[proofId]/view", () => {
  afterEach(() => vi.resetAllMocks());

  it("mints a URL with the institution resolved from the slug", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    generateManualProofViewUrl.mockResolvedValue({ url: "https://r2.example/signed", expiresIn: 300 });

    const response = await POST(viewRequest(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://r2.example/signed", expiresIn: 300 });
    expect(generateManualProofViewUrl).toHaveBeenCalledWith("inst_a", "org_1", "proof_1", {});
  });

  it("mints NOTHING when the caller does not administer the institution", async () => {
    // The audit row is written inside the service, so a call that reaches it at all has already
    // recorded an access. The boundary must therefore refuse BEFORE the service, not inside it.
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockRejectedValue(new AccessError("forbidden", 403, "nope"));

    expect((await POST(viewRequest(), context)).status).toBe(403);
    expect(generateManualProofViewUrl).not.toHaveBeenCalled();
  });

  it("mints NOTHING for an unauthenticated caller", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, "nope"));

    expect((await POST(viewRequest(), context)).status).toBe(401);
    expect(requireAdminInstitutionBySlug).not.toHaveBeenCalled();
    expect(generateManualProofViewUrl).not.toHaveBeenCalled();
  });

  it("passes a foreign proof through as the service's not-found, unchanged", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    generateManualProofViewUrl.mockRejectedValue(
      new ManualProofError("manual_proof_not_found", "Bukti transfer tidak ditemukan", 404),
    );

    const response = await POST(viewRequest(), context);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("manual_proof_not_found");
    expect(body.error.message).toBe("Bukti transfer tidak ditemukan");
  });

  it("surfaces an object-store outage as a refusal, in Indonesian, not as a crash", async () => {
    requireAuthenticatedSession.mockResolvedValue(ORGANISER);
    requireAdminInstitutionBySlug.mockResolvedValue({ institutionId: "inst_a" });
    generateManualProofViewUrl.mockRejectedValue(
      new ManualProofError(
        "manual_proof_upload_unavailable",
        "Penyimpanan berkas sedang tidak tersedia. Coba lagi beberapa saat lagi.",
        503,
      ),
    );

    const response = await POST(viewRequest(), context);
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(503);
    expect(body.error.message).toContain("tidak tersedia");
  });
});
