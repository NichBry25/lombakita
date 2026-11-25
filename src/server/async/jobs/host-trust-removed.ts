import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/async/jobs/host-trust-removed");

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { asSentence } from "@/lib/finance/payment-display";
import { logger } from "@/lib/logger";
import { ASYNC_JOB_NAMES, type HostTrustRemovedPayload } from "@/server/async/contracts";
import { sendHostTrustRemovedEmail } from "@/server/notifications/notification-email";
import { writeInboxNotificationSafely } from "@/server/notifications/inbox-write";
import { NOTIFICATION_TYPES } from "@/server/notifications/notification-types";

export type HostTrustRemovedJob = Job<
  HostTrustRemovedPayload,
  void,
  typeof ASYNC_JOB_NAMES.hostTrustRemoved
>;

const TRUST_REMOVED_TITLE = "Status tepercaya Anda dicabut";

// A reason is free staff text, so one without a closing full stop gets one before the next sentence.
const trustRemovedBodyOf = (reason: string): string =>
  `Alasan: ${asSentence(reason)} Kompetisi yang sudah tayang tetap tayang. Kompetisi berikutnya diperiksa staf sebelum tayang.`;

// Tells a host that staff removed their trust. The reason comes from the payload, and only the
// recipient's address is looked up.
export const processHostTrustRemovedJob = async (job: HostTrustRemovedJob): Promise<void> => {
  const { userId, reason } = job.data;

  const db = getDb();

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    logger.warn("notification.failed", {
      event: "host.trust.removed",
      reason: "user_not_found",
      jobId: job.id,
      userId,
    });
    return;
  }

  const body = trustRemovedBodyOf(reason);

  // Dual-channel (DEC-0076): in-app row written FIRST, isolated and swallowed. The email block keeps
  // its rethrow-for-retry semantics so the row lands regardless of email outcome.
  await writeInboxNotificationSafely(
    db,
    { userId, type: NOTIFICATION_TYPES.hostTrustRemoved, title: TRUST_REMOVED_TITLE, body },
    { event: "host.trust.removed", jobId: job.id ?? undefined },
  );

  try {
    await sendHostTrustRemovedEmail({
      toEmail: user.email,
      recipientId: userId,
      title: TRUST_REMOVED_TITLE,
      body,
    });
  } catch (error) {
    logger.error("notification.failed", {
      event: "host.trust.removed",
      jobId: job.id,
      recipientId: userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};
