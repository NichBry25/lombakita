// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, createIndividualRegistration } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  createIndividualRegistration: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/registrations/registration-service", () => ({ createIndividualRegistration }));

import { POST } from "./route";

const studentSession = {
  user: { id: "stud_1", role: "candidate", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeContext = (competitionId = "comp_1") => ({
  params: Promise.resolve({ competitionId }),
});

const makeRequest = () =>
  new Request("http://localhost/api/v1/competitions/comp_1/registrations", { method: "POST" });

describe("POST /api/v1/competitions/[competitionId]/registrations", () => {
  afterEach(() => vi.clearAllMocks());

  const sampleRegistration = {
    id: "reg_1",
    competitionId: "comp_1",
    studentId: "stud_1",
    registrationType: "individual",
    status: "confirmed",
    registeredAt: new Date().toISOString(),
    cancelledAt: null,
    cancellationReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("returns 201 with registration on success", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    createIndividualRegistration.mockResolvedValue(sampleRegistration);

    const res = await POST(makeRequest() as never, makeContext());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.registration.id).toBe("reg_1");
    expect(createIndividualRegistration).toHaveBeenCalledWith("stud_1", "comp_1");
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await POST(makeRequest() as never, makeContext());
    expect(res.status).toBe(401);
    expect(createIndividualRegistration).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is institution_admin (not a student)", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));

    const res = await POST(makeRequest() as never, makeContext());
    expect(res.status).toBe(403);
    expect(createIndividualRegistration).not.toHaveBeenCalled();
  });

  it("forwards RegistrationError with correct status (404 competition_not_found)", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    const { RegistrationError } = await import("@/server/registrations/registration-core");
    createIndividualRegistration.mockRejectedValue(
      new RegistrationError("competition_not_found", "Competition not found"),
    );

    const res = await POST(makeRequest() as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("competition_not_found");
  });

  it("forwards RegistrationError with correct status (422 ineligible)", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    const { RegistrationError } = await import("@/server/registrations/registration-core");
    createIndividualRegistration.mockRejectedValue(
      new RegistrationError("registration_ineligible", "Not eligible", {
        eligibilityStatus: "incomplete",
      }),
    );

    const res = await POST(makeRequest() as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("registration_ineligible");
    expect(body.error.details.eligibilityStatus).toBe("incomplete");
  });

  it("forwards RegistrationError with correct status (409 already exists)", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    const { RegistrationError } = await import("@/server/registrations/registration-core");
    createIndividualRegistration.mockRejectedValue(
      new RegistrationError("registration_already_exists", "Already registered"),
    );

    const res = await POST(makeRequest() as never, makeContext());
    expect(res.status).toBe(409);
  });
});
