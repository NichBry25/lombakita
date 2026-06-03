// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, requireSessionRole, listUserInbox, countUnreadInboxItems } =
  vi.hoisted(() => ({
    requireAuthenticatedSession: vi.fn(),
    requireSessionRole: vi.fn(),
    listUserInbox: vi.fn(),
    countUnreadInboxItems: vi.fn(),
  }));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession, requireSessionRole }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/notifications/inbox-service", () => ({ listUserInbox, countUnreadInboxItems }));

import { GET } from "./route";

const session = (id: string) => ({
  user: { id, role: "candidate", email: `${id}@example.com` },
  expires: new Date(Date.now() + 60_000).toISOString(),
});

const makeRequest = () => new Request("http://localhost/api/v1/me/inbox");

describe("GET /api/v1/me/inbox", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await GET(makeRequest() as never);
    expect(res.status).toBe(401);
  });

  it("returns 200 with { items, unreadCount } for an authenticated user", async () => {
    requireAuthenticatedSession.mockResolvedValue(session("user_1"));
    listUserInbox.mockResolvedValue([
      { kind: "notification", id: "n1", type: "registration_confirmed", title: "T", body: "B", readAt: null, createdAt: new Date() },
    ]);
    countUnreadInboxItems.mockResolvedValue(1);

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.unreadCount).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe("notification");
  });

  it("scopes the inbox to the session user id (no cross-user reads)", async () => {
    requireAuthenticatedSession.mockResolvedValue(session("user_A"));
    listUserInbox.mockResolvedValue([]);
    countUnreadInboxItems.mockResolvedValue(0);

    const res = await GET(makeRequest() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
    // The service is only ever asked for the calling user's own items.
    expect(listUserInbox).toHaveBeenCalledWith("user_A", expect.anything());
    expect(countUnreadInboxItems).toHaveBeenCalledWith("user_A", expect.anything());
  });
});
