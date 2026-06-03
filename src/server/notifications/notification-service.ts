import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/notifications/notification-service");

import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { notifications } from "@/server/db/schema";
import type { NotificationType } from "@/server/notifications/notification-types";

// Accept either the root Drizzle client or an open transaction handle. Workers call this with
// `getDb()` (web/worker runtime client); future callers that want the in-app row written inside the
// same transaction as a state mutation can pass the `tx` from `db.transaction(...)`.
export type NotificationWriter = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

// Step 6.5.1 — plain insert of one in-app notification row. This is the storage half of the
// dual-channel model (DEC-0076). It THROWS on DB failure; it does not swallow. Callers (the BullMQ
// workers) are responsible for wrapping it in an isolated try/catch so an inbox-write failure never
// blocks or rethrows past the email-delivery path.
export const writeNotification = async (
  db: NotificationWriter,
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
): Promise<void> => {
  await db.insert(notifications).values({
    userId,
    type,
    title,
    body,
  });
};

export type MarkNotificationReadResult = { found: boolean };

// Step 6.5.1 — mark one notification as read, scoped to its owner.
//
// Ownership and existence collapse into a single guard: the lookup filters on BOTH id AND userId,
// so a notification that does not exist and one owned by another user are indistinguishable —
// both return `{ found: false }` (the route maps this to 404, no information leak). Already-read
// rows return `{ found: true }` without a write (idempotent). The UPDATE keeps an `IS NULL` guard
// so a concurrent double-mark is a no-op rather than a clobber.
export const markNotificationAsRead = async (
  userId: string,
  notificationId: string,
  db: Database = getDb(),
): Promise<MarkNotificationReadResult> => {
  const [row] = await db
    .select({ id: notifications.id, readAt: notifications.readAt })
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .limit(1);

  if (!row) {
    return { found: false };
  }

  if (row.readAt) {
    return { found: true };
  }

  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    );

  return { found: true };
};

// Step 6.5.1 — delete one of the caller's own notifications. Same ownership+existence collapse as
// markNotificationAsRead: the DELETE filters on `id AND user_id`, so a foreign-owned or absent id
// removes nothing and returns `{ found: false }` (route → 404, no information leak). Invitations are
// not deletable here — only notification rows.
export const deleteNotification = async (
  userId: string,
  notificationId: string,
  db: Database = getDb(),
): Promise<MarkNotificationReadResult> => {
  const deleted = await db
    .delete(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning({ id: notifications.id });

  return { found: deleted.length > 0 };
};
