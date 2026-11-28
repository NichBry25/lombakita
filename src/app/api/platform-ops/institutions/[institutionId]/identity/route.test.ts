// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { VerificationError } from "@/server/institution-verification/verification-core";
import { InstitutionWorkspaceInputError } from "@/server/institution-workspace/institution-core";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";

const { requireSessionRole, renameInstitutionAsStaff } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  renameInstitutionAsStaff: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/institution-workspace/institution-staff-rename-service", () => ({
  renameInstitutionAsStaff,
}));

import { PATCH } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const renamed = { institutionId: "i1", displayName: "Nama Baru", slug: "nama-baru" };
const req = (body: unknown) =>
  new Request("http://localhost", { method: "PATCH", body: JSON.stringify(body) });
const params = (institutionId: string) => ({ params: Promise.resolve({ institutionId }) });

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  renameInstitutionAsStaff.mockResolvedValue(renamed);
});
afterEach(() => vi.clearAllMocks());

describe("PATCH /api/platform-ops/institutions/[institutionId]/identity", () => {
  it("returns 200 on success", async () => {
    const body = { displayName: "Nama Baru", slug: "nama-baru", reason: "Sesuai dokumen." };
    const res = await PATCH(req(body), params("i1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ institution: renamed });
    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
    expect(renameInstitutionAsStaff).toHaveBeenCalledWith("ops1", "i1", body);
  });

  it("returns 403 when caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));
    const res = await PATCH(req({ displayName: "Nama Baru", reason: "x" }), params("i1"));
    expect(res.status).toBe(403);
    expect(renameInstitutionAsStaff).not.toHaveBeenCalled();
  });

  it("returns the service's refusal with its status and code", async () => {
    renameInstitutionAsStaff.mockRejectedValueOnce(
      new InstitutionWorkspaceInputError(
        "institution_slug_reserved",
        "slug is reserved",
        { fields: ["slug"] },
        422,
      ),
    );
    const slugRefusal = await PATCH(req({ slug: "admin", reason: "x" }), params("i1"));
    expect(slugRefusal.status).toBe(422);
    expect((await slugRefusal.json()).error.code).toBe("institution_slug_reserved");

    renameInstitutionAsStaff.mockRejectedValueOnce(
      new VerificationError("verification_transition_conflict", 409, "tick moved"),
    );
    const conflict = await PATCH(req({ displayName: "Nama Baru", reason: "x" }), params("i1"));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("verification_transition_conflict");
  });

  it("returns 403 JSON for a database actor refusal", async () => {
    renameInstitutionAsStaff.mockRejectedValueOnce(
      new OperatorActorError("operator_actor_conflicted", 403, "actor refused"),
    );
    const res = await PATCH(req({ displayName: "Nama Baru", reason: "x" }), params("i1"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "operator_actor_conflicted", message: "actor refused" },
    });
  });

  it("reads a body that is not JSON as a request with no fields and no reason", async () => {
    const res = await PATCH(
      new Request("http://localhost", { method: "PATCH", body: "{" }),
      params("i1"),
    );
    expect(res.status).toBe(200);
    expect(renameInstitutionAsStaff).toHaveBeenCalledWith("ops1", "i1", { reason: "" });
  });

  it("passes only the displayName, slug and reason of the body", async () => {
    await PATCH(
      req({ displayName: "Nama Baru", reason: "Sesuai dokumen.", description: "diabaikan" }),
      params("i1"),
    );
    expect(renameInstitutionAsStaff).toHaveBeenCalledWith("ops1", "i1", {
      displayName: "Nama Baru",
      reason: "Sesuai dokumen.",
    });
  });
});
