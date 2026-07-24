import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-reviews-service");

import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitionRegistrations,
  competitionReviews,
  platformOpsAuditLogs,
  userProfiles,
  users,
} from "@/server/db/schema";
import {
  CompetitionReviewError,
  parseCompetitionReviewInput,
} from "@/server/competitions/competition-reviews-core";

export type CompetitionReviewRecord = {
  id: string;
  rating: number;
  body: string | null;
  status: "visible" | "hidden";
  createdAt: Date;
};

export type PublicReviewRecord = {
  rating: number;
  body: string | null;
  authorName: string;
  createdAt: Date;
};

export type ReviewSummary = {
  count: number;
  average: number | null;
};

// A user may review a competition only if they hold a confirmed registration for it. This is the
// trust boundary (a confirmed registration, not proven completion — see plan highlight #5). Covers
// individual registrants and team captains (the registration row's student_id); team members
// without their own registration row are out of scope at MVP.
export const hasConfirmedRegistration = async (
  userId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const [row] = await db
    .select({ id: competitionRegistrations.id })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.competitionId, competitionId),
        eq(competitionRegistrations.studentId, userId),
        eq(competitionRegistrations.status, "confirmed"),
      ),
    )
    .limit(1);
  return Boolean(row);
};

export const getMyReview = async (
  userId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<CompetitionReviewRecord | null> => {
  const [row] = await db
    .select({
      id: competitionReviews.id,
      rating: competitionReviews.rating,
      body: competitionReviews.body,
      status: competitionReviews.status,
      createdAt: competitionReviews.createdAt,
    })
    .from(competitionReviews)
    .where(
      and(
        eq(competitionReviews.competitionId, competitionId),
        eq(competitionReviews.authorUserId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
};

// Create or update the caller's review. Refuses callers without a confirmed registration. Editing a
// review never changes its moderation status (a hidden review stays hidden on re-submit).
export const upsertMyReview = async (
  userId: string,
  competitionId: string,
  payload: unknown,
  db: Database = getDb(),
): Promise<CompetitionReviewRecord> => {
  const input = parseCompetitionReviewInput(payload);

  const eligible = await hasConfirmedRegistration(userId, competitionId, db);
  if (!eligible) {
    throw new CompetitionReviewError(
      "review_not_eligible",
      "Only participants with a confirmed registration can review this competition",
      403,
    );
  }

  await db
    .insert(competitionReviews)
    .values({ competitionId, authorUserId: userId, rating: input.rating, body: input.body })
    .onConflictDoUpdate({
      target: [competitionReviews.competitionId, competitionReviews.authorUserId],
      set: { rating: input.rating, body: input.body, updatedAt: sql`now()` },
    });

  const review = await getMyReview(userId, competitionId, db);
  if (!review) throw new Error("review upsert returned no row");
  return review;
};

const authorNameSql = sql<string>`COALESCE(${userProfiles.displayName}, ${users.username}, 'Peserta')`;

export const listPublicReviews = async (
  competitionId: string,
  limit = 20,
  db: Database = getDb(),
): Promise<PublicReviewRecord[]> => {
  const rows = await db
    .select({
      rating: competitionReviews.rating,
      body: competitionReviews.body,
      authorName: authorNameSql,
      createdAt: competitionReviews.createdAt,
    })
    .from(competitionReviews)
    .innerJoin(users, eq(users.id, competitionReviews.authorUserId))
    .leftJoin(userProfiles, eq(userProfiles.userId, competitionReviews.authorUserId))
    .where(
      and(
        eq(competitionReviews.competitionId, competitionId),
        eq(competitionReviews.status, "visible"),
      ),
    )
    .orderBy(desc(competitionReviews.createdAt))
    .limit(limit);
  return rows;
};

export const getReviewSummary = async (
  competitionId: string,
  db: Database = getDb(),
): Promise<ReviewSummary> => {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      average: sql<number | null>`avg(${competitionReviews.rating})::float`,
    })
    .from(competitionReviews)
    .where(
      and(
        eq(competitionReviews.competitionId, competitionId),
        eq(competitionReviews.status, "visible"),
      ),
    );
  return {
    count: row?.count ?? 0,
    average: row?.average ?? null,
  };
};

// Platform-ops moderation: hide or restore a review. Records a platform_ops_audit_logs row keyed on
// the review author (the affected user), with the review id in metadata, in the same transaction.
export const setReviewStatus = async (
  actorUserId: string,
  reviewId: string,
  status: "visible" | "hidden",
  reason: string,
  db: Database = getDb(),
): Promise<CompetitionReviewRecord> => {
  const cleanReason = reason.trim();
  if (cleanReason.length === 0) {
    throw new CompetitionReviewError("review_invalid_value", "A reason is required", 400, {
      fields: ["reason"],
    });
  }

  const [existing] = await db
    .select({ id: competitionReviews.id, authorUserId: competitionReviews.authorUserId })
    .from(competitionReviews)
    .where(eq(competitionReviews.id, reviewId))
    .limit(1);
  if (!existing) {
    throw new CompetitionReviewError("review_not_found", "Review not found", 404);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(competitionReviews)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(competitionReviews.id, reviewId));
    await tx.insert(platformOpsAuditLogs).values({
      actorUserId,
      targetUserId: existing.authorUserId,
      eventType: status === "hidden" ? "competition_review.hidden" : "competition_review.restored",
      reason: cleanReason,
      metadata: { reviewId },
    });
  });

  const [updated] = await db
    .select({
      id: competitionReviews.id,
      rating: competitionReviews.rating,
      body: competitionReviews.body,
      status: competitionReviews.status,
      createdAt: competitionReviews.createdAt,
    })
    .from(competitionReviews)
    .where(eq(competitionReviews.id, reviewId))
    .limit(1);
  if (!updated) throw new Error("review status update returned no row");
  return updated;
};
