// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, listHostChecks } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  listHostChecks: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/host-trust/host-check-decision-service", () => ({ listHostChecks }));

import { GET } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  listHostChecks.mockResolvedValue([{ id: "check_1" }]);
});
afterEach(() => vi.clearAllMocks());

describe("GET host-checks", () => {
  it("returns the queue for platform_ops", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hostChecks: [{ id: "check_1" }] });
    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
  });

  it("returns 403 and reads nothing when the caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));

    const response = await GET();

    expect(response.status).toBe(403);
    expect(listHostChecks).not.toHaveBeenCalled();
  });
});
