// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, cancelRegistration } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  cancelRegistration: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/registrations/registration-service", () => ({ cancelRegistration }));

import { DELETE } from "./route";

const studentSession = {
  user: { id: "stud_1", role: "student", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeContext = () => ({
  params: Promise.resolve({ competitionId: "comp_1", registrationId: "reg_1" }),
});

const makeRequest = (body?: unknown) =>
  new Request("http://localhost/api/v1/competitions/comp_1/registrations/reg_1", {
    method: "DELETE",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

describe("DELETE /api/v1/competitions/[competitionId]/registrations/[registrationId]", () => {
  afterEach(() => vi.clearAllMocks());

  const cancelledRow = {
    id: "reg_1",
    competitionId: "comp_1",
    studentId: "stud_1",
    registrationType: "individual",
    status: "cancelled",
    registeredAt: new Date().toISOString(),
    cancelledAt: new Date().toISOString(),
    cancellationReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("returns 200 with the updated record on success (no body)", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    cancelRegistration.mockResolvedValue(cancelledRow);

    const res = await DELETE(makeRequest() as never, makeContext());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.registration.status).toBe("cancelled");
    expect(cancelRegistration).toHaveBeenCalledWith("stud_1", "comp_1", "reg_1", null);
  });

  it("forwards an optional cancellationReason from the body", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    cancelRegistration.mockResolvedValue({ ...cancelledRow, cancellationReason: "changed mind" });

    await DELETE(makeRequest({ cancellationReason: "changed mind" }) as never, makeContext());

    expect(cancelRegistration).toHaveBeenCalledWith("stud_1", "comp_1", "reg_1", "changed mind");
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await DELETE(makeRequest() as never, makeContext());
    expect(res.status).toBe(401);
    expect(cancelRegistration).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is institution_admin", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));

    const res = await DELETE(makeRequest() as never, makeContext());
    expect(res.status).toBe(403);
  });

  it("returns 403 with registration_not_owner when registration belongs to another student", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    const { RegistrationError } = await import("@/server/registrations/registration-core");
    cancelRegistration.mockRejectedValue(
      new RegistrationError("registration_not_owner", "Not owner"),
    );

    const res = await DELETE(makeRequest() as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("registration_not_owner");
  });

  it("returns 409 with registration_wrong_status when already cancelled", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    const { RegistrationError } = await import("@/server/registrations/registration-core");
    cancelRegistration.mockRejectedValue(
      new RegistrationError("registration_wrong_status", "Already cancelled"),
    );

    const res = await DELETE(makeRequest() as never, makeContext());
    expect(res.status).toBe(409);
  });

  it("returns 409 with registration_deadline_passed after deadline", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    const { RegistrationError } = await import("@/server/registrations/registration-core");
    cancelRegistration.mockRejectedValue(
      new RegistrationError("registration_deadline_passed", "Past deadline"),
    );

    const res = await DELETE(makeRequest() as never, makeContext());
    expect(res.status).toBe(409);
  });

  it("returns 400 when JSON body is malformed", async () => {
    requireSessionRole.mockResolvedValue(studentSession);

    const req = new Request("http://localhost/api/v1/competitions/comp_1/registrations/reg_1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await DELETE(req as never, makeContext());
    expect(res.status).toBe(400);
    expect(cancelRegistration).not.toHaveBeenCalled();
  });
});
