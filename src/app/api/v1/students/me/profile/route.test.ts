// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { StudentProfileInputError } from "@/server/student-profile/profile-core";

const { requireSessionRole, getStudentProfileForUser, updateStudentProfileForUser } = vi.hoisted(
  () => ({
    requireSessionRole: vi.fn(),
    getStudentProfileForUser: vi.fn(),
    updateStudentProfileForUser: vi.fn(),
  }),
);

vi.mock("@/server/auth/session", () => ({
  requireSessionRole,
}));

vi.mock("@/server/student-profile/profile-service", () => ({
  getStudentProfileForUser,
  updateStudentProfileForUser,
}));

import { GET, PATCH } from "@/app/api/v1/students/me/profile/route";

const sessionFixture = {
  user: {
    id: "student_1",
    role: "student",
    email: "student@example.com",
  },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

describe("GET /api/v1/students/me/profile", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns current authenticated student profile", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);
    getStudentProfileForUser.mockResolvedValue({
      userId: "student_1",
      email: "student@example.com",
      displayName: "Bima Pratama",
      phoneNumber: "+628111222333",
      headline: "Aktif di kompetisi UI/UX",
      createdAt: new Date("2026-04-10T10:00:00.000Z"),
      updatedAt: new Date("2026-04-15T11:00:00.000Z"),
    });

    const response = await GET(new Request("http://localhost/api/v1/students/me/profile") as never);
    const body = await response.json();

    expect(requireSessionRole).toHaveBeenCalledWith(["student"]);
    expect(getStudentProfileForUser).toHaveBeenCalledWith("student_1");
    expect(response.status).toBe(200);
    expect(body.profile.email).toBe("student@example.com");
  });

  it("blocks unauthenticated access", async () => {
    requireSessionRole.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const response = await GET(new Request("http://localhost/api/v1/students/me/profile") as never);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthenticated");
  });
});

describe("PATCH /api/v1/students/me/profile", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("updates whitelisted profile fields for the current student only", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);
    updateStudentProfileForUser.mockResolvedValue({
      userId: "student_1",
      email: "student@example.com",
      displayName: "Bima Pratama",
      phoneNumber: "+6282112345678",
      headline: "Aktif di kompetisi teknologi",
      createdAt: new Date("2026-04-10T10:00:00.000Z"),
      updatedAt: new Date("2026-04-15T13:00:00.000Z"),
    });

    const request = new Request("http://localhost/api/v1/students/me/profile", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Bima Pratama",
        phoneNumber: "+6282112345678",
        headline: "Aktif di kompetisi teknologi",
      }),
    });

    const response = await PATCH(request as never);
    const body = await response.json();

    expect(requireSessionRole).toHaveBeenCalledWith(["student"]);
    expect(updateStudentProfileForUser).toHaveBeenCalledWith("student_1", {
      displayName: "Bima Pratama",
      phoneNumber: "+6282112345678",
      headline: "Aktif di kompetisi teknologi",
    });
    expect(response.status).toBe(200);
    expect(body.profile.phoneNumber).toBe("+6282112345678");
  });

  it("returns 400 for protected field mutation attempts", async () => {
    requireSessionRole.mockResolvedValue(sessionFixture);
    updateStudentProfileForUser.mockRejectedValue(
      new StudentProfileInputError(
        "profile_protected_fields",
        "Some fields cannot be modified through this profile endpoint",
        { fields: ["email"] },
      ),
    );

    const request = new Request("http://localhost/api/v1/students/me/profile", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "forbidden@example.com",
      }),
    });

    const response = await PATCH(request as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("profile_protected_fields");
    expect(body.error.details.fields).toContain("email");
  });
});
