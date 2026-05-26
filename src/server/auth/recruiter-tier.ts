import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  recruiterVerificationTierEnum,
  users,
  type RecruiterVerificationTier,
} from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import type { AuthenticatedSession } from "@/server/auth/access-core";

assertServerOnly("server/auth/recruiter-tier");

// Step 4.0c (CCR-19 / DEC-0053) — Recruiter Tier State.
//
// Tier order at launch: unverified < minimal < elevated. Tier is monotonically increasing — no
// downgrade or revocation path exists. The recruiter mode must already be verified
// (recruiterVerifiedAt IS NOT NULL) for any tier above `unverified` to be meaningful; the
// assertion helper enforces both conditions in lockstep.
export const RECRUITER_TIERS = recruiterVerificationTierEnum.enumValues;
export type { RecruiterVerificationTier };

const TIER_RANK: Record<RecruiterVerificationTier, number> = {
  unverified: 0,
  minimal: 1,
  elevated: 2,
};

export const isRecruiterTier = (value: unknown): value is RecruiterVerificationTier => {
  return (
    typeof value === "string" && (RECRUITER_TIERS as readonly string[]).includes(value)
  );
};

// Named threshold for the institution opportunity creation gate. Step 4.0c locks this at
// `minimal` so existing signup flows are unblocked the moment they complete `?as=recruiter`
// registration. Any future surface that requires `elevated` must declare its own constant in
// this file rather than inline-passing a string literal.
export const OPPORTUNITY_CREATION_MIN_TIER: RecruiterVerificationTier = "minimal";

export type RecruiterTierFailureReason =
  | "recruiter_role_not_verified"
  | "recruiter_tier_insufficient";

export class RecruiterTierError extends Error {
  constructor(
    public readonly code: RecruiterTierFailureReason,
    public readonly status: 403,
    message: string,
    public readonly details?: {
      requiredTier: RecruiterVerificationTier;
      currentTier?: RecruiterVerificationTier;
    },
  ) {
    super(message);
  }
}

type AccountTierState = {
  recruiterVerified: boolean;
  recruiterVerificationTier: RecruiterVerificationTier;
};

const readAccountTierState = async (
  userId: string,
  db: Database,
): Promise<AccountTierState | null> => {
  const [row] = await db
    .select({
      recruiterVerifiedAt: users.recruiterVerifiedAt,
      recruiterVerificationTier: users.recruiterVerificationTier,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) return null;

  return {
    recruiterVerified: row.recruiterVerifiedAt !== null,
    recruiterVerificationTier: row.recruiterVerificationTier,
  };
};

export const meetsRecruiterTier = (
  current: RecruiterVerificationTier,
  minTier: RecruiterVerificationTier,
): boolean => {
  return TIER_RANK[current] >= TIER_RANK[minTier];
};

// Server-side recruiter tier assertion. Reads tier from the DB (not the JWT) so a fresh
// platform-ops elevation takes effect on the very next request without waiting for a JWT
// refresh cycle. Throws RecruiterTierError if the account has not verified the recruiter mode
// OR if the tier is below the requested threshold.
//
// Callers must already have established the actor's session (via requireAuthenticatedSession or
// withApiRole); this helper only enforces the tier dimension on top of that.
export const assertRecruiterTier = async (
  session: AuthenticatedSession,
  minTier: RecruiterVerificationTier,
  db: Database = getDb(),
): Promise<void> => {
  const state = await readAccountTierState(session.user.id, db);

  if (!state || !state.recruiterVerified) {
    throw new RecruiterTierError(
      "recruiter_role_not_verified",
      403,
      "Recruiter role verification is required to perform this action",
      { requiredTier: minTier },
    );
  }

  if (!meetsRecruiterTier(state.recruiterVerificationTier, minTier)) {
    throw new RecruiterTierError(
      "recruiter_tier_insufficient",
      403,
      `Recruiter tier '${minTier}' is required to perform this action`,
      { requiredTier: minTier, currentTier: state.recruiterVerificationTier },
    );
  }
};

// Convenience read for callers that need the tier value itself rather than an assertion (e.g.
// the platform-ops elevation endpoint, which must distinguish "no-op already at target" from
// "true elevation"). Returns null when the account does not exist.
export const getRecruiterTierForAccount = async (
  userId: string,
  db: Database = getDb(),
): Promise<AccountTierState | null> => {
  return readAccountTierState(userId, db);
};
