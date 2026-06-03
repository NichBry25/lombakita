import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/notifications/inbox-write");

import { logger } from "@/lib/logger";
import {
  writeNotification,
  type NotificationWriter,
} from "@/server/notifications/notification-service";
import type { NotificationType } from "@/server/notifications/notification-types";

// Step 6.5.1 — the isolated in-app-notification write block shared by every dual-write worker.
//
// This is the "separate try/catch" the dual-channel retrofit requires: it wraps the throwing
// `writeNotification` primitive so an inbox-write failure is caught, logged at warn level
// (`notification.inbox.failed`), and SWALLOWED — never rethrown. That guarantees a DB failure in
// the notification path can never propagate past the worker's email block (which keeps its own
// rethrow-on-failure semantics for BullMQ retry). On success it logs `notification.inbox.written`.
//
// Callers invoke this AFTER their email dispatch block. Keeping the try/catch in one place keeps
// the six worker call sites identical in their failure contract.
export const writeInboxNotificationSafely = async (
  db: NotificationWriter,
  input: {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
  },
  context: { event: string; jobId?: string | undefined },
): Promise<void> => {
  try {
    await writeNotification(db, input.userId, input.type, input.title, input.body);
    logger.info("notification.inbox.written", {
      userId: input.userId,
      type: input.type,
    });
  } catch (error) {
    logger.warn("notification.inbox.failed", {
      event: context.event,
      jobId: context.jobId,
      userId: input.userId,
      type: input.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
