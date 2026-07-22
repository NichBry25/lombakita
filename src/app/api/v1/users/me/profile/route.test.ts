// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import { ProfileInputError } from "@/server/user-profile/profile-core";
import { emptyProfileCollections } from "@/server/user-profile/profile-collections-core";

const { requireAuthenticatedSession, getOwnerProfile, updateOwnerProfile } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  getOwnerProfile: vi.fn(),
  updateOwnerProfile: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
  requireAuthenticatedSession,
}));

vi.mock("@/server/user-profile/profile-service", () => ({
  getOwnerProfile,
  updateOwnerProfile,
}));

import { GET, PATCH } from "@/app/api/v1/users/me/profile/route";

const sessionFixture = {
  user: { id: "user_1", role: "candidate", email: "user@example.com" },
  expires: new Date(Date.now() + 60_000).toISOString(),
};

const ownerProfileFixture = {
  username: "john_abc1",
  email: "user@example.com",
  role: "candidate",
  candidateVerified: true,
  recruiterVerified: false,
  displayName: { status: "populated", value: "John Doe" },
  bio: { status: "empty", value: null },
  location: { status: "empty", value: null },
  avatarUrl: { status: "empty", value: null },
  collections: emptyProfileCollections(),
};

describe("GET /api/v1/users/me/profile", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the owner profile with collections", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    getOwnerProfile.mockResolvedValue(ownerProfileFixture);

    const res = await GET(new Request("http://localhost/api/v1/users/me/profile") as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.profile.username).toBe("john_abc1");
    expect(body.profile.collections).toEqual(emptyProfileCollections());
    expect(getOwnerProfile).toHaveBeenCalledWith("user_1");
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const res = await GET(new Request("http://localhost/api/v1/users/me/profile") as never);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/v1/users/me/profile", () => {
  afterEach(() => vi.clearAllMocks());

  it("updates shared fields and returns updated owner response", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateOwnerProfile.mockResolvedValue({
      ...ownerProfileFixture,
      bio: { status: "populated", value: "Updated bio" },
    });

    const req = new Request("http://localhost/api/v1/users/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bio: "Updated bio" }),
    });

    const res = await PATCH(req as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.profile.bio).toEqual({ status: "populated", value: "Updated bio" });
    expect(updateOwnerProfile).toHaveBeenCalledWith(
      "user_1",
      expect.objectContaining({ bio: "Updated bio" }),
    );
  });

  it("rejects a retired scoped field as an unknown field (400)", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);

    const req = new Request("http://localhost/api/v1/users/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleTitle: "CEO" }),
    });

    const res = await PATCH(req as never);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("profile_invalid_fields");
    expect(updateOwnerProfile).not.toHaveBeenCalled();
  });

  it("returns 400 for protected field mutation", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);

    const req = new Request("http://localhost/api/v1/users/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "hax@example.com" }),
    });

    const res = await PATCH(req as never);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("profile_protected_fields");
  });

  it("returns 409 when username is already taken (service throws)", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateOwnerProfile.mockRejectedValue(
      new ProfileInputError("profile_username_taken", "This username is already taken", {
        fields: ["username"],
      }),
    );

    const req = new Request("http://localhost/api/v1/users/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "takename" }),
    });

    const res = await PATCH(req as never);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("profile_username_taken");
  });

  it("returns 422 profile_username_reserved when the submitted username is a reserved word", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);

    const req = new Request("http://localhost/api/v1/users/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin" }),
    });

    const res = await PATCH(req as never);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error.code).toBe("profile_username_reserved");
    expect(updateOwnerProfile).not.toHaveBeenCalled();
  });

  it("passes a valid non-reserved username through to the service uniqueness check", async () => {
    requireAuthenticatedSession.mockResolvedValue(sessionFixture);
    updateOwnerProfile.mockResolvedValue(ownerProfileFixture);

    const req = new Request("http://localhost/api/v1/users/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "valid_handle" }),
    });

    const res = await PATCH(req as never);

    expect(res.status).toBe(200);
    expect(updateOwnerProfile).toHaveBeenCalledWith(
      "user_1",
      expect.objectContaining({ username: "valid_handle" }),
    );
  });

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(
      new AccessError("unauthenticated", 401, "Authentication required"),
    );

    const req = new Request("http://localhost/api/v1/users/me/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bio: "test" }),
    });

    const res = await PATCH(req as never);
    expect(res.status).toBe(401);
  });
});
