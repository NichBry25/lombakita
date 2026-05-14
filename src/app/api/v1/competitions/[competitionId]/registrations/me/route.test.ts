// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, getStudentRegistration } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  getStudentRegistration: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/registrations/registration-service", () => ({ getStudentRegistration }));

import { GET } from "./route";

const studentSession = {
  user: { id: "stud_1", role: "student", email: "stud@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const otherStudentSession = {
  user: { id: "stud_2", role: "student", email: "stud2@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const makeContext = (competitionId = "comp_1") => ({
  params: Promise.resolve({ competitionId }),
});

const makeRequest = () =>
  new Request("http://localhost/api/v1/competitions/comp_1/registrations/me");

describe("GET /api/v1/competitions/[competitionId]/registrations/me", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the calling student's registration when one exists", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    getStudentRegistration.mockResolvedValue({
      id: "reg_1",
      competitionId: "comp_1",
      studentId: "stud_1",
      status: "confirmed",
    });

    const res = await GET(makeRequest() as never, makeContext());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.registration.id).toBe("reg_1");
    expect(getStudentRegistration).toHaveBeenCalledWith("stud_1", "comp_1");
  });

  it("returns 404 when no registration exists for the calling student", async () => {
    requireSessionRole.mockResolvedValue(studentSession);
    getStudentRegistration.mockResolvedValue(null);

    const res = await GET(makeRequest() as never, makeContext());
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("registration_not_found");
  });

  it("scopes the lookup to the calling session user — never another student", async () => {
    requireSessionRole.mockResolvedValue(otherStudentSession);
    getStudentRegistration.mockResolvedValue(null);

    await GET(makeRequest() as never, makeContext());
    expect(getStudentRegistration).toHaveBeenCalledWith("stud_2", "comp_1");
  });

  it("returns 401 when unauthenticated", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await GET(makeRequest() as never, makeContext());
    expect(res.status).toBe(401);
    expect(getStudentRegistration).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is platform_ops (not a student)", async () => {
    requireSessionRole.mockRejectedValue(new AccessError("forbidden", 403, ""));

    const res = await GET(makeRequest() as never, makeContext());
    expect(res.status).toBe(403);
  });
});
