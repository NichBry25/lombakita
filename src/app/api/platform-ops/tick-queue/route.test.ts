// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireSessionRole, listTickQueue } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  listTickQueue: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/institution-verification/name-check-service", () => ({ listTickQueue }));

import { GET } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };
const QUEUE = { requests: [{ submissionId: "sub_1" }], nameChecks: [], runningProofs: [] };

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  listTickQueue.mockResolvedValue(QUEUE);
});
afterEach(() => vi.clearAllMocks());

describe("GET tick-queue", () => {
  it("returns the queue for platform_ops", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tickQueue: QUEUE });
    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
  });

  it("returns 403 and reads nothing when the caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));

    const response = await GET();

    expect(response.status).toBe(403);
    expect(listTickQueue).not.toHaveBeenCalled();
  });
});
