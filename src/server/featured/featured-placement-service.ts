import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/featured/featured-placement-service");

import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitions } from "@/server/db/schema";
import { logger } from "@/lib/logger";
import { enqueueCompetitionSearchSync } from "@/server/async/enqueue";

export type FeaturedPlacementErrorCode =
  | "competition_not_found"
  | "competition_not_published";

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
    .select({ id: competitions.id, status: competitions.status })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);

  if (!row) {
    throw new FeaturedPlacementError("competition_not_found", 404, "Competition not found");
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
