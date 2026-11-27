// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import type { HostTrustWatchItem } from "@/components/admin/host-trust-watch-list";
import type { HostTrustWatchEntry } from "@/server/host-trust/host-trust-watch-service";

const { requireSessionRole, listHostTrustWatch } = vi.hoisted(() => ({
  requireSessionRole: vi.fn(),
  listHostTrustWatch: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireSessionRole }));
vi.mock("@/server/host-trust/host-trust-watch-service", () => ({ listHostTrustWatch }));

import { GET } from "./route";

const opsSession = { user: { id: "ops1", role: "platform_ops" }, expires: "x" };

// Typed on both sides of the route, so a field renamed in the service or in the staff watch list
// fails the type check here, and a key the route answers differently fails the run.
const WATCH_ENTRY: HostTrustWatchEntry = {
  userId: "u7",
  name: "Sari Wulandari",
  signInEmail: "sari.host@acme.example",
  organizationEmail: "sari@acme.example",
  domain: "acme.example",
  trustedSince: new Date("2026-11-20T03:04:05.000Z"),
  watchEndsAt: new Date("2027-02-18T03:04:05.000Z"),
};

const WATCH_ITEM: HostTrustWatchItem = {
  userId: "u7",
  name: "Sari Wulandari",
  signInEmail: "sari.host@acme.example",
  organizationEmail: "sari@acme.example",
  domain: "acme.example",
  trustedSince: "2026-11-20T03:04:05.000Z",
  watchEndsAt: "2027-02-18T03:04:05.000Z",
};

beforeEach(() => {
  requireSessionRole.mockResolvedValue(opsSession);
  listHostTrustWatch.mockResolvedValue([{ userId: "u1" }]);
});
afterEach(() => vi.clearAllMocks());

describe("GET host-trust-watch", () => {
  it("returns the watch list for platform_ops", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ watchList: [{ userId: "u1" }] });
    expect(requireSessionRole).toHaveBeenCalledWith(["platform_ops"]);
  });

  it("answers a watch item with exactly the fields the staff watch list reads, its two dates as ISO strings", async () => {
    listHostTrustWatch.mockResolvedValueOnce([WATCH_ENTRY]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ watchList: [WATCH_ITEM] });
  });

  it("returns 403 and reads nothing when the caller is not platform_ops", async () => {
    requireSessionRole.mockRejectedValueOnce(new AccessError("forbidden", 403, "no"));

    const response = await GET();

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("forbidden");
    expect(listHostTrustWatch).not.toHaveBeenCalled();
  });

  it("returns 403 and reads nothing for an operator who has not passed the MFA challenge", async () => {
    requireSessionRole.mockRejectedValueOnce(
      new AccessError("mfa_challenge_required", 403, "challenge"),
    );

    const response = await GET();

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("mfa_challenge_required");
    expect(listHostTrustWatch).not.toHaveBeenCalled();
  });
});
