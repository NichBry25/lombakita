// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, markNotificationAsRead } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  markNotificationAsRead: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/notifications/notification-service", () => ({ markNotificationAsRead }));

import { PATCH } from "./route";

const session = (id: string) => ({
  user: { id, role: "candidate", email: `${id}@example.com` },
  expires: new Date(Date.now() + 60_000).toISOString(),
});

const makeRequest = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/v1/me/notifications/notif_1/read", {
    method: "PATCH",
    headers,
  });

const params = (notificationId = "notif_1") => ({
  params: Promise.resolve({ notificationId }),
});

describe("PATCH /api/v1/me/notifications/[notificationId]/read", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await PATCH(makeRequest(), params());
    expect(res.status).toBe(401);
    expect(markNotificationAsRead).not.toHaveBeenCalled();
  });

  it("returns 404 when the notification is not owned by the caller (no information leak)", async () => {
    requireAuthenticatedSession.mockResolvedValue(session("user_1"));
    markNotificationAsRead.mockResolvedValue({ found: false });

    const res = await PATCH(makeRequest(), params());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("notification_not_found");
  });

  it("returns 200 when marking an owned notification, and is idempotent on repeat", async () => {
    requireAuthenticatedSession.mockResolvedValue(session("user_1"));
    markNotificationAsRead.mockResolvedValue({ found: true });

    const first = await PATCH(makeRequest(), params());
    const second = await PATCH(makeRequest(), params());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(markNotificationAsRead).toHaveBeenCalledWith("user_1", "notif_1", expect.anything());
  });

  it("returns 409 when the expected-user header disagrees with the session (Rule #16)", async () => {
    requireAuthenticatedSession.mockResolvedValue(session("user_1"));

    const res = await PATCH(makeRequest({ "x-expected-user-id": "user_2" }), params());

    expect(res.status).toBe(409);
    expect(markNotificationAsRead).not.toHaveBeenCalled();
  });
});
