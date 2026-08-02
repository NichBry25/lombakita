import { and, eq, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import { platformOpsAuditLogs, users } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  getRecruiterTierForAccount,
  isRecruiterTier,
  type RecruiterVerificationTier,
} from "@/server/auth/recruiter-tier";
import { sweepOrphanedObjectsForAccount } from "@/server/recruiter-verification/recruiter-verification-service";

assertServerOnly("server/recruiter-tier/recruiter-tier-service");

// Platform-ops manual tier elevation.
//
// The endpoint is intentionally minimal: only `elevated` is accepted as a target. Other
// tier transitions are not allowed at launch (no demotion, no setting back to `minimal`).
// There is no mechanical/automated elevation path; this endpoint is the only
// path to `elevated` at launch.

export type TierElevationErrorCode =
  | "tier_invalid_payload"
  | "tier_invalid_target"
  | "tier_account_not_found"
  | "tier_target_not_recruiter_verified";

export class RecruiterTierElevationError extends Error {
  constructor(
    public readonly code: TierElevationErrorCode,
    public readonly status: 400 | 404 | 422,
    message: string,
  ) {
    super(message);
  }
}

// Only `elevated` is settable via the platform-ops endpoint at launch. The constant is exported
// so route tests can pin against the same value the implementation uses.
export const ELEVATION_TARGET_TIER: RecruiterVerificationTier = "elevated";

// Audit event type for a manual elevation, distinct from `recruiter_verification.approved` so a
// reader can tell whether the account went through document review or was elevated directly.
export const RECRUITER_TIER_ELEVATED_EVENT = "recruiter_tier.elevated";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export type ParsedElevationInput = {
  tier: typeof ELEVATION_TARGET_TIER;
};

export const parseElevationInput = (payload: unknown): ParsedElevationInput => {
  if (!isRecord(payload)) {
    throw new RecruiterTierElevationError(
      "tier_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }

  const { tier } = payload;

  if (!isRecruiterTier(tier) || tier !== ELEVATION_TARGET_TIER) {
    throw new RecruiterTierElevationError(
      "tier_invalid_target",
      400,
      `Only tier='${ELEVATION_TARGET_TIER}' is accepted at this endpoint`,
    );
  }

  return { tier };
};

export type TierElevationResult = {
  accountId: string;
  tier: RecruiterVerificationTier;
  changed: boolean;
};

// Elevates a recruiter-verified account to `elevated`. Idempotent: a second call returns
// `changed: false` with the current tier. Rejects targets whose recruiter mode is not verified.
export const elevateRecruiterTier = async (
  actorUserId: string,
  accountId: string,
  db: Database = getDb(),
): Promise<TierElevationResult> => {
  const current = await getRecruiterTierForAccount(accountId, db);

  if (!current) {
    throw new RecruiterTierElevationError("tier_account_not_found", 404, "Account not found");
  }

  if (!current.recruiterVerified) {
    throw new RecruiterTierElevationError(
      "tier_target_not_recruiter_verified",
      422,
      "Account does not hold a verified recruiter role and cannot be elevated",
    );
  }

  if (current.recruiterVerificationTier === ELEVATION_TARGET_TIER) {
    return { accountId, tier: ELEVATION_TARGET_TIER, changed: false };
  }

  // Conditional UPDATE: only flip from a non-elevated tier. Prevents a race where two concurrent
  // ops requests both observe the same starting tier and stomp on each other; one wins, the other
  // matches zero rows and reports `changed: false`.
  //
  // The audit row is written in the same transaction as the flip, and only when the flip actually
  // lands, so the trail records elevations that happened and never one that lost a race. This
  // manual path carries the same audit weight as an approval through the review queue — the two
  // routes reach an identical end state and must be equally visible.
  const elevated = await db.transaction(async (tx) => {
    const flipped = await tx
      .update(users)
      .set({
        recruiterVerificationTier: ELEVATION_TARGET_TIER,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(users.id, accountId),
          eq(users.recruiterVerificationTier, current.recruiterVerificationTier),
        ),
      )
      .returning({ id: users.id });

    if (flipped.length === 0) {
      return false;
    }

    await tx.insert(platformOpsAuditLogs).values({
      actorUserId,
      targetUserId: accountId,
      eventType: RECRUITER_TIER_ELEVATED_EVENT,
      metadata: { from: current.recruiterVerificationTier, to: ELEVATION_TARGET_TIER },
    });

    return true;
  });

  if (!elevated) {
    return { accountId, tier: ELEVATION_TARGET_TIER, changed: false };
  }

  logger.info(RECRUITER_TIER_ELEVATED_EVENT, {
    accountId,
    actorUserId,
    from: current.recruiterVerificationTier,
    to: ELEVATION_TARGET_TIER,
  });

  // This manual path bypasses the review flow's terminal orphan sweep, so run it here: reclaim any
  // upload the account left behind on its still-pending submission. Best-effort — never blocks the
  // elevation it follows.
  await sweepOrphanedObjectsForAccount(accountId, db);

  return { accountId, tier: ELEVATION_TARGET_TIER, changed: true };
};
