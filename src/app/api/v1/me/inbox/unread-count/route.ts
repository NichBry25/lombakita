import { NextResponse } from "next/server";
import { withApiAuth } from "@/server/auth/api-guard";
import { getDb } from "@/server/db/client";
import { countUnreadInboxItems } from "@/server/notifications/inbox-service";

// Lightweight unread-count endpoint for the homepage notification bell to poll.
// Returns only the scalar count (not the full inbox), so the bell's periodic poll stays cheap.
// Not role-scoped: any authenticated user reads their own count; `withApiAuth` returns 401 for
// unauthenticated callers, which the bell treats as "hide".
export const GET = withApiAuth(async (_request, session) => {
  const unreadCount = await countUnreadInboxItems(session.user.id, getDb());
  return NextResponse.json({ unreadCount });
});
