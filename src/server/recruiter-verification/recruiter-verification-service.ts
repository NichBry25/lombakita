import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/recruiter-verification/recruiter-verification-service");

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import {
  recruiterVerificationDocuments,
  recruiterVerificationSubmissions,
} from "@/server/db/schema";
import { deleteObject, isR2Available, listObjects } from "@/server/storage/r2.client";

// The proof documents of older host requests stay in storage until the account is deleted, and
// nothing uploads new ones. What remains here is the sweep of the objects under a request's prefix
// that no document row names.

// The window the request form gave a presigned PUT. A sweep that respects age leaves an object
// younger than this alone.
const PRESIGNED_UPLOAD_EXPIRY_SECONDS = 300;

// The statuses in which the request form let the account change its documents, so the only ones
// whose prefix can hold an object no row names.
const EDITABLE_SUBMISSION_STATUSES = ["draft", "rejected"] as const;

// The account's request whose objects the account sweep reads: a draft wins over a rejected row, and
// among rejected rows the most recent wins. Null when the account has none.
const findEditableSubmissionIdForUser = async (
  userId: string,
  db: Database,
): Promise<string | null> => {
  const [editable] = await db
    .select({ id: recruiterVerificationSubmissions.id })
    .from(recruiterVerificationSubmissions)
    .where(
      and(
        eq(recruiterVerificationSubmissions.userId, userId),
        inArray(recruiterVerificationSubmissions.status, [...EDITABLE_SUBMISSION_STATUSES]),
      ),
    )
    .orderBy(
      sql`(${recruiterVerificationSubmissions.status} = 'draft') desc`,
      desc(recruiterVerificationSubmissions.submittedAt),
    )
    .limit(1);

  return editable?.id ?? null;
};

// Removes the objects under one request's prefix that no document row names. Best-effort and never
// throws, so a storage fault does not break the staff raise or the retention run beside it.
// respectAge leaves an object younger than the upload window alone.
export const sweepOrphanedSubmissionObjects = async (
  userId: string,
  submissionId: string,
  options: { respectAge: boolean },
  db: Database = getDb(),
): Promise<void> => {
  if (!isR2Available()) return;

  const prefix = `recruiter-verification/${userId}/${submissionId}/`;
  try {
    const objects = await listObjects(prefix);
    if (objects.length === 0) return;

    const rows = await db
      .select({ r2Key: recruiterVerificationDocuments.r2Key })
      .from(recruiterVerificationDocuments)
      .where(eq(recruiterVerificationDocuments.submissionId, submissionId));
    const referenced = new Set(rows.map((row) => row.r2Key));

    const cutoff = Date.now() - PRESIGNED_UPLOAD_EXPIRY_SECONDS * 1000;
    for (const object of objects) {
      if (referenced.has(object.key)) continue;
      if (options.respectAge && object.lastModified && object.lastModified.getTime() > cutoff) {
        continue;
      }
      await deleteObject(object.key);
    }
  } catch (error) {
    logger.warn("recruiter_verification.orphan_sweep_failed", {
      submissionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// The account-level sweep, for the staff raise: the objects of the account's editable request, if
// it has one. No-op when it has none or storage is unconfigured. Never throws.
export const sweepOrphanedObjectsForAccount = async (
  userId: string,
  db: Database = getDb(),
): Promise<void> => {
  if (!isR2Available()) return;
  try {
    const submissionId = await findEditableSubmissionIdForUser(userId, db);
    if (!submissionId) return;
    await sweepOrphanedSubmissionObjects(userId, submissionId, { respectAge: true }, db);
  } catch (error) {
    logger.warn("recruiter_verification.account_orphan_sweep_failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
