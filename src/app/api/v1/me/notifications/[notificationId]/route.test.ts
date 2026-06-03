// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";

const { requireAuthenticatedSession, deleteNotification } = vi.hoisted(() => ({
  requireAuthenticatedSession: vi.fn(),
  deleteNotification: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ requireAuthenticatedSession }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/notifications/notification-service", () => ({ deleteNotification }));

import { DELETE } from "./route";

const session = (id: string) => ({
  user: { id, role: "candidate", email: `${id}@example.com` },
  expires: new Date(Date.now() + 60_000).toISOString(),
});

const makeRequest = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/v1/me/notifications/notif_1", {
    method: "DELETE",
    headers,
  });

const params = (notificationId = "notif_1") => ({
  params: Promise.resolve({ notificationId }),
});

describe("DELETE /api/v1/me/notifications/[notificationId]", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    requireAuthenticatedSession.mockRejectedValue(new AccessError("unauthenticated", 401, ""));

    const res = await DELETE(makeRequest(), params());
    expect(res.status).toBe(401);
    expect(deleteNotification).not.toHaveBeenCalled();
  });

  it("returns 404 when the notification is not owned by the caller (no information leak)", async () => {
    requireAuthenticatedSession.mockResolvedValue(session("user_1"));
    deleteNotification.mockResolvedValue({ found: false });

    const res = await DELETE(makeRequest(), params());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("notification_not_found");
  });

  it("returns 200 when the caller's own notification is deleted", async () => {
    requireAuthenticatedSession.mockResolvedValue(session("user_1"));
    deleteNotification.mockResolvedValue({ found: true });

    const res = await DELETE(makeRequest(), params());

    expect(res.status).toBe(200);
    expect(deleteNotification).toHaveBeenCalledWith("user_1", "notif_1", expect.anything());
  });

  it("returns 409 when the expected-user header disagrees with the session (Rule #16)", async () => {
    requireAuthenticatedSession.mockResolvedValue(session("user_1"));

    const res = await DELETE(makeRequest({ "x-expected-user-id": "user_2" }), params());

    expect(res.status).toBe(409);
    expect(deleteNotification).not.toHaveBeenCalled();
  });
});
