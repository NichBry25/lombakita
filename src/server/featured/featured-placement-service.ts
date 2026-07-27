import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/featured/featured-placement-service");

import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitions, institutions, platformOpsAuditLogs } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { enqueueCompetitionSearchSync } from "@/server/async/enqueue";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";

export type FeaturedPlacementErrorCode =
  | "competition_not_found"
  | "competition_not_published"
  // Step 6.5f.1 — personal institutions cannot receive featured placement.
  | "competition_personal_not_featurable";

export class FeaturedPlacementError extends Error {
  constructor(
    public readonly code: FeaturedPlacementErrorCode,
    public readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "FeaturedPlacementError";
  }
}

export const toFeaturedPlacementErrorResponse = (error: FeaturedPlacementError) => ({
  error: { code: error.code, message: error.message },
});

export type SetFeaturedPlacementInput = {
  isFeatured: boolean;
  featuredOrder: number | null;
};

export type SetFeaturedPlacementResult = {
  isFeatured: boolean;
  featuredOrder: number | null;
};

// Set and cleared are separate event types so the audit trail answers "when did this leave the
// front page" without a reader having to inspect metadata.
export const FEATURED_SET_EVENT = "featured_placement.set";
export const FEATURED_CLEARED_EVENT = "featured_placement.cleared";

export const setFeaturedPlacement = async (
  actorUserId: string,
  competitionId: string,
  input: SetFeaturedPlacementInput,
  db: Database = getDb(),
): Promise<SetFeaturedPlacementResult> => {
  const [row] = await db
    .select({
      id: competitions.id,
      status: competitions.status,
      institutionId: competitions.institutionId,
      institutionType: institutions.institutionType,
    })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(eq(competitions.id, competitionId))
    .limit(1);

  if (!row) {
    throw new FeaturedPlacementError("competition_not_found", 404, "Competition not found");
  }

  // Step 6.5f.1 — personal institutions are excluded from featured placement. No-op for full or
  // legacy institutions (NULL type).
  if (isPersonalInstitutionType(row.institutionType)) {
    throw new FeaturedPlacementError(
      "competition_personal_not_featurable",
      409,
      "Competitions owned by a personal institution cannot be featured",
    );
  }

  if (row.status !== "published") {
    throw new FeaturedPlacementError(
      "competition_not_published",
      409,
      "Only published competitions can be featured",
    );
  }

  // When unsetting featured, clear featuredOrder regardless of passed value.
  const resolvedOrder = input.isFeatured ? (input.featuredOrder ?? null) : null;

  // Placement change and audit row land in one transaction. Featured placement is the front-page
  // slot and a monetized surface, so "who featured this, and when" must be answerable from the
  // audit trail rather than from server logs. The audit table requires a user or institution
  // target and a competition is neither, so the owning institution is the target and the
  // competition id rides in metadata.
  await db.transaction(async (tx) => {
    await tx
      .update(competitions)
      .set({
        isFeatured: input.isFeatured,
        featuredOrder: resolvedOrder,
        updatedAt: new Date(),
      })
      .where(eq(competitions.id, competitionId));

    await tx.insert(platformOpsAuditLogs).values({
      actorUserId,
      targetInstitutionId: row.institutionId,
      eventType: input.isFeatured ? FEATURED_SET_EVENT : FEATURED_CLEARED_EVENT,
      metadata: { competitionId, featuredOrder: resolvedOrder },
    });
  });

  logger.info("featured_placement.set", { competitionId, isFeatured: input.isFeatured });

  // Fire-and-forget search sync — enqueue failure must not block the DB write.
  try {
    await enqueueCompetitionSearchSync({ competitionId, action: "upsert" });
  } catch (err) {
    logger.warn("featured-placement.enqueue_failed", {
      competitionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { isFeatured: input.isFeatured, featuredOrder: resolvedOrder };
};
