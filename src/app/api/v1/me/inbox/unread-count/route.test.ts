// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, requireSessionRole, countUnreadInboxItems } = vi.hoisted(
  () => ({
    requireAuthenticatedSession: vi.fn(),
    requireSessionRole: vi.fn(),
    countUnreadInboxItems: vi.fn(),
  }),
);

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession, requireSessionRole }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/notifications/inbox-service", () => ({ countUnreadInboxItems }));

import { GET } from "./route";

const session = (id: string) => ({
  user: { id, role: "candidate", email: `${id}@example.com` },
  expires: new Date(Date.now() + 60_000).toISOString(),
});

const makeRequest = () => new Request("http://localhost/api/v1/me/inbox/unread-count");

describe("GET /api/v1/me/inbox/unread-count", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, ""));
    const res = await GET(makeRequest() as never);
    expect(res.status).toBe(401);
  });

  it("returns the caller's own unread count", async () => {
    requireAuthenticatedSession.mockResolvedValue(session("user_1"));
    countUnreadInboxItems.mockResolvedValue(3);

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ unreadCount: 3 });
    expect(countUnreadInboxItems).toHaveBeenCalledWith("user_1", expect.anything());
  });
});
