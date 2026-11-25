import { and, eq, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { enqueueRecruiterVerificationApproved } from "@/server/async/enqueue";
import { getDb, type Database } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  OperatorActorError,
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
} from "@/server/platform-ops/operator-actor";
import {
  getRecruiterTierForAccount,
  isRecruiterTier,
  type RecruiterVerificationTier,
} from "@/server/auth/recruiter-tier";
import { sweepOrphanedObjectsForAccount } from "@/server/recruiter-verification/recruiter-verification-service";
import { closeOpenHostCheckAsApproved } from "@/server/host-trust/host-check-decision-service";
import { assertAccountNotDeactivated } from "@/server/accounts/deactivated-account";

assertServerOnly("server/recruiter-tier/recruiter-tier-service");

// Platform-ops manual tier raise. The only target is `elevated`. A raise also clears a staff trust
// removal and closes the account's open host check as approved, naming it in the audit row, without
// publishing its draft.

export type TierElevationErrorCode =
  | "tier_invalid_payload"
  | "tier_invalid_target"
  | "tier_account_not_found"
  | "tier_target_not_recruiter_verified"
  | "tier_target_email_not_verified"
  | "account_deactivated";

export class RecruiterTierElevationError extends Error {
  constructor(
    public readonly code: TierElevationErrorCode,
    public readonly status: 400 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

// Only `elevated` is settable via the platform-ops endpoint at launch. The constant is exported
// so route tests can pin against the same value the implementation uses.
export const ELEVATION_TARGET_TIER: RecruiterVerificationTier = "elevated";

// Audit event type for a manual elevation, distinct from `host_check.approved` so a reader can tell
// whether staff approved a host check or raised the account directly.
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
// `changed: false` with the current tier. Rejects targets whose recruiter mode is not verified,
// and targets whose email address is not verified.
//
// THE ACTOR IS RESOLVED, NOT ACCEPTED. `actorUserId` is a claim; `resolvePlatformOpsActor` asks the
// database and refuses a caller whose account does not exist, does not hold `platform_ops`, or is
// suspended (LAUNCH-D72). The route already gates on `requireSessionRole(["platform_ops"])`, and
// this second resolution is not redundant: the service is reachable from anywhere in the server,
// and a route gate protects the route rather than the service.
//
// Every read below — the actor included — happens inside the one transaction that writes the audit
// row, and the actor is read FIRST. A caller that has no business here therefore learns nothing
// about the target, not even whether it exists.
//
// THE ACTOR MAY NOT BE THE TARGET (LAUNCH-D72; the finding it was previously attributed to is
// docs/project/archive/reviews/step-7.7-C2-phase-1-review.md, re-review finding 1). A
// `platform_ops` account that also holds a recruiter role is a target this endpoint can name, and
// the audit row it would write names the same id on both sides — a self-grant that reads exactly
// like a reviewed one. The database lowers the tier only from elevated to minimal and only inside a
// transaction that set lombakita.trust_removal to its own transaction id, which this path never
// does, so an operator who elevated itself could not be walked back by it. The refusal sits with
// the other three, before the target row is read.
export const elevateRecruiterTier = async (
  actorUserId: string,
  accountId: string,
  db: Database = getDb(),
): Promise<TierElevationResult> => {
  // Conditional UPDATE: only flip from a non-elevated tier. Prevents a race where two concurrent
  // ops requests both observe the same starting tier and stomp on each other; one wins, the other
  // matches zero rows and reports `changed: false`.
  //
  // The audit row is written in the same transaction as the flip, and only when the flip actually
  // lands, so the trail records elevations that happened and never one that lost a race. The raise
  // carries the same audit weight as a host check approval, because both reach the same tier and
  // must be equally visible.
  const outcome = await db.transaction(async (tx) => {
    const actor = await resolvePlatformOpsActor(tx, actorUserId);

    if (actor.userId === accountId) {
      throw new OperatorActorError(
        "operator_actor_is_target",
        403,
        "A platform-ops account cannot elevate its own recruiter tier",
      );
    }

    await assertAccountNotDeactivated(tx, accountId, RecruiterTierElevationError);

    const current = await getRecruiterTierForAccount(accountId, tx);

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

    // A recruiter sign-up before its address is proven may be a stranger's,
    // and verification never lowers the tier.
    const [emailState] = await tx
      .select({ emailVerified: users.emailVerified, hostTrustRemovedAt: users.hostTrustRemovedAt })
      .from(users)
      .where(eq(users.id, accountId))
      .limit(1);

    if (!emailState?.emailVerified) {
      throw new RecruiterTierElevationError(
        "tier_target_email_not_verified",
        422,
        "Account has not verified its email address and cannot be elevated",
      );
    }

    if (current.recruiterVerificationTier === ELEVATION_TARGET_TIER) {
      return { changed: false, actorUserId: actor.userId, from: current.recruiterVerificationTier };
    }

    const flipped = await tx
      .update(users)
      .set({
        recruiterVerificationTier: ELEVATION_TARGET_TIER,
        hostTrustRemovedAt: null,
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
      return { changed: false, actorUserId: actor.userId, from: current.recruiterVerificationTier };
    }

    const closedHostCheckId = await closeOpenHostCheckAsApproved(tx, accountId, actor.userId);

    await recordOperatorAuditEntry(tx, actor, {
      targetUserId: accountId,
      eventType: RECRUITER_TIER_ELEVATED_EVENT,
      metadata: {
        from: current.recruiterVerificationTier,
        to: ELEVATION_TARGET_TIER,
        clearedTrustRemoval: emailState.hostTrustRemovedAt !== null,
        closedHostCheckId,
      },
    });

    return { changed: true, actorUserId: actor.userId, from: current.recruiterVerificationTier };
  });

  if (!outcome.changed) {
    return { accountId, tier: ELEVATION_TARGET_TIER, changed: false };
  }

  logger.info(RECRUITER_TIER_ELEVATED_EVENT, {
    accountId,
    actorUserId: outcome.actorUserId,
    from: outcome.from,
    to: ELEVATION_TARGET_TIER,
  });

  try {
    await enqueueRecruiterVerificationApproved({ userId: accountId, epoch: Date.now() });
  } catch (error) {
    logger.warn("recruiter_tier.approval_notice_enqueue_failed", {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Reclaims any upload an older host request of this account left with no document row. Best
  // effort, never blocks the elevation it follows.
  await sweepOrphanedObjectsForAccount(accountId, db);

  return { accountId, tier: ELEVATION_TARGET_TIER, changed: true };
};
