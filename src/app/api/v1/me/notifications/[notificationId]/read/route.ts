import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import {
  assertSessionMatchesExpectedUser,
  toAccessDeniedResponse,
} from "@/server/auth/access-core";
import { getDb } from "@/server/db/client";
import { markNotificationAsRead } from "@/server/notifications/notification-service";

// Mark one of the caller's own notifications as read.
//
// Acts on the caller's OWN data (userId derived from the session), so CLAUDE.md Rule #16 applies:
// the cross-session guard runs immediately after the auth gate. Ownership + existence collapse in
// the service to a single 404 (no information leak between "not found" and "owned by someone else").
// Idempotent: re-marking an already-read notification returns 200 without a write.
export async function PATCH(
  request: Request,
  context: { params: Promise<{ notificationId: string }> },
) {
  try {
    const session = await requireAuthenticatedSession();
    assertSessionMatchesExpectedUser(request, session);

    const { notificationId } = await context.params;
    const result = await markNotificationAsRead(session.user.id, notificationId, getDb());

    if (!result.found) {
      return NextResponse.json(
        { error: { code: "notification_not_found", message: "Notification not found" } },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
