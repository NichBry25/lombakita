import { NextResponse } from "next/server";
import { withApiAuth } from "@/server/auth/api-guard";
import { getDb } from "@/server/db/client";
import {
  countUnreadInboxItems,
  listUserInbox,
} from "@/server/notifications/inbox-service";

// Step 6.5.1 — unified inbox read endpoint. Not role-scoped: any authenticated user (candidate or
// recruiter) reads their OWN inbox. `withApiAuth` runs `assertAuthenticatedSession()` only — no
// role gate (per the step contract). All items are scoped to `session.user.id` by the service, so
// a cross-user request simply returns that caller's (possibly empty) inbox, never another user's.
export const GET = withApiAuth(async (_request, session) => {
  const db = getDb();
  const [items, unreadCount] = await Promise.all([
    listUserInbox(session.user.id, db),
    countUnreadInboxItems(session.user.id, db),
  ]);

  return NextResponse.json({ items, unreadCount });
});
