// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { VerificationError } from "@/server/institution-verification/verification-core";

const { requireAuthenticatedSession, verifyInstitution } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  verifyInstitution: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/institution-verification/verification-service", () => ({ verifyInstitution }));

import { PATCH } from "@/app/api/admin/institutions/[id]/verify/route";

const platformOpsSession = {
  user: { id: "ops_1", role: "platform_ops", email: "ops@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const institutionAdminSession = {
  user: { id: "admin_1", role: "recruiter", email: "admin@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeRequest = (body: unknown) =>
  new Request("http://localhost", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const makeParams = (id: string) => ({
  params: Promise.resolve({ id }),
});

const mockVerifyResult = {
  institution: {
    id: "inst_1",
    verificationStatus: "under_review",
    verifiedAt: null,
    rejectedAt: null,
    rejectionReason: null,
  },
  auditEntry: {
    id: "audit_1",
    actorUserId: "ops_1",
    fromStatus: "pending_verification",
    toStatus: "under_review",
    reason: null,
    createdAt: new Date().toISOString(),
  },
};

describe("PATCH /api/admin/institutions/[id]/verify", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 200 on successful transition to under_review", async () => {
    requireAuthenticatedSession.mockResolvedValue(platformOpsSession);
    verifyInstitution.mockResolvedValue(mockVerifyResult);

    const response = await PATCH(
      makeRequest({ targetStatus: "under_review" }) as never,
      makeParams("inst_1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.institution.verificationStatus).toBe("under_review");
    expect(verifyInstitution).toHaveBeenCalledWith(
      expect.objectContaining({
        institutionId: "inst_1",
        targetStatus: "under_review",
        actorUserId: "ops_1",
        actorRole: "platform_ops",
      }),
    );
  });

  it("returns 403 when called by recruiter (not platform_ops)", async () => {
    requireAuthenticatedSession.mockResolvedValue(institutionAdminSession);
    verifyInstitution.mockRejectedValue(
      new AccessError("forbidden", 403, "platform_ops access required"),
    );

    const response = await PATCH(
      makeRequest({ targetStatus: "under_review" }) as never,
      makeParams("inst_1"),
    );

    expect(response.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const response = await PATCH(
      makeRequest({ targetStatus: "under_review" }) as never,
      makeParams("inst_1"),
    );

    expect(response.status).toBe(401);
  });

  it("returns 422 when rejecting without reason", async () => {
    requireAuthenticatedSession.mockResolvedValue(platformOpsSession);

    const response = await PATCH(
      makeRequest({ targetStatus: "rejected" }) as never,
      makeParams("inst_1"),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("verification_reason_required");
    expect(verifyInstitution).not.toHaveBeenCalled();
  });

  it("returns 409 on invalid transition (e.g. pending_verification → verified)", async () => {
    requireAuthenticatedSession.mockResolvedValue(platformOpsSession);
    verifyInstitution.mockRejectedValue(
      new VerificationError(
        "verification_invalid_transition",
        409,
        "Cannot transition from 'pending_verification' to 'verified'",
      ),
    );

    const response = await PATCH(
      makeRequest({ targetStatus: "verified" }) as never,
      makeParams("inst_1"),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("verification_invalid_transition");
  });

  it("returns 400 for invalid JSON body", async () => {
    requireAuthenticatedSession.mockResolvedValue(platformOpsSession);

    const request = new Request("http://localhost", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    const response = await PATCH(request as never, makeParams("inst_1"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("verification_invalid_payload");
  });

  it("returns 200 on rejection with reason and writes audit entry", async () => {
    requireAuthenticatedSession.mockResolvedValue(platformOpsSession);
    const rejectedResult = {
      institution: {
        id: "inst_1",
        verificationStatus: "rejected",
        verifiedAt: null,
        rejectedAt: new Date().toISOString(),
        rejectionReason: "Dokumen tidak lengkap",
      },
      auditEntry: {
        id: "audit_2",
        actorUserId: "ops_1",
        fromStatus: "under_review",
        toStatus: "rejected",
        reason: "Dokumen tidak lengkap",
        createdAt: new Date().toISOString(),
      },
    };
    verifyInstitution.mockResolvedValue(rejectedResult);

    const response = await PATCH(
      makeRequest({ targetStatus: "rejected", reason: "Dokumen tidak lengkap" }) as never,
      makeParams("inst_1"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.institution.verificationStatus).toBe("rejected");
    expect(body.auditEntry.reason).toBe("Dokumen tidak lengkap");
    expect(verifyInstitution).toHaveBeenCalledWith(
      expect.objectContaining({
        targetStatus: "rejected",
        reason: "Dokumen tidak lengkap",
      }),
    );
  });
});
