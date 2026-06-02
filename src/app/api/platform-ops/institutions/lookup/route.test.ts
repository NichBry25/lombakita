// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, lookupInstitutionBySlug } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  lookupInstitutionBySlug: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/moderation/lookup-service", () => ({ lookupInstitutionBySlug }));

import { GET } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const req = (qs: string) =>
  new Request(`http://localhost/api/platform-ops/institutions/lookup${qs}`);

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  lookupInstitutionBySlug.mockResolvedValue({ id: "i1", slug: "inst" });
});
afterEach(() => vi.clearAllMocks());

describe("GET /api/platform-ops/institutions/lookup", () => {
  it("returns 200 with the institution on hit", async () => {
    const res = await GET(req("?slug=inst"));
    expect(res.status).toBe(200);
  });

  it("returns 400 when slug is absent", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(400);
  });

  it("returns 404 when no institution matches", async () => {
    lookupInstitutionBySlug.mockResolvedValueOnce(null);
    const res = await GET(req("?slug=nope"));
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));
    const res = await GET(req("?slug=inst"));
    expect(res.status).toBe(403);
  });
});
