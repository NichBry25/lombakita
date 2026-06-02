// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, lookupUserByEmail } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  lookupUserByEmail: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/moderation/lookup-service", () => ({ lookupUserByEmail }));

import { GET } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const req = (qs: string) => new Request(`http://localhost/api/platform-ops/users/lookup${qs}`);

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  lookupUserByEmail.mockResolvedValue({ id: "u1", email: "a@b.com" });
});
afterEach(() => vi.clearAllMocks());

describe("GET /api/platform-ops/users/lookup", () => {
  it("returns 200 with the user on hit", async () => {
    const res = await GET(req("?email=a@b.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe("u1");
  });

  it("returns 400 when email is absent", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(400);
  });

  it("returns 404 when no user matches", async () => {
    lookupUserByEmail.mockResolvedValueOnce(null);
    const res = await GET(req("?email=missing@b.com"));
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));
    const res = await GET(req("?email=a@b.com"));
    expect(res.status).toBe(403);
  });
});
