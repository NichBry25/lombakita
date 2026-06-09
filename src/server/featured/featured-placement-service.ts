import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/featured/featured-placement-service");

import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitions, institutions } from "@/server/db/schema";
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

export const setFeaturedPlacement = async (
  competitionId: string,
  input: SetFeaturedPlacementInput,
  db: Database = getDb(),
): Promise<SetFeaturedPlacementResult> => {
  const [row] = await db
    .select({
      id: competitions.id,
      status: competitions.status,
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

  await db
    .update(competitions)
    .set({
      isFeatured: input.isFeatured,
      featuredOrder: resolvedOrder,
      updatedAt: new Date(),
    })
    .where(eq(competitions.id, competitionId));

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
