import { eq, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import { users } from "@/server/db/schema";
import type { CandidateProfileInput } from "@/server/candidate/candidate-profile-core";
import { insertCandidateProfileInTransaction } from "@/server/candidate/candidate-profile-service";
import type { RecruiterVerificationInput } from "@/server/recruiter-verification/recruiter-verification-core";
import { createRecruiterVerificationSubmissionInTransaction } from "@/server/recruiter-verification/recruiter-verification-service";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/role-verification");

// Step 4.0b — Role verification entry points.
//
// The set of roles a user-level account may verify. Note this is intentionally narrower than
// AppRole — `reviewer_or_judge`, `platform_ops`, and `finance_ops` are not user-self-verifiable
// role-modes; they are operational roles outside the candidate/recruiter dual-mode model.
export const VERIFIABLE_ROLES = ["candidate", "recruiter"] as const;
export type VerifiableRole = (typeof VERIFIABLE_ROLES)[number];

export const isVerifiableRole = (value: unknown): value is VerifiableRole => {
  return typeof value === "string" && (VERIFIABLE_ROLES as readonly string[]).includes(value);
};

export type VerificationState = {
  candidateVerified: boolean;
  recruiterVerified: boolean;
};

const readVerificationState = async (
  userId: string,
  db: Database = getDb(),
): Promise<VerificationState | null> => {
  const [row] = await db
    .select({
      candidateVerifiedAt: users.candidateVerifiedAt,
      recruiterVerifiedAt: users.recruiterVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) return null;

  return {
    candidateVerified: row.candidateVerifiedAt !== null,
    recruiterVerified: row.recruiterVerifiedAt !== null,
  };
};

// Returns the set of verifiable roles the account has NOT yet verified. Pure derivation against
// the live DB row — not the JWT — because the JWT may be one refresh cycle stale after a fresh
// verification grant. Visibility-decision callers must read from here, not from
// session.user.verifiedRoles.
export const getUnverifiedRoles = async (
  userId: string,
  db: Database = getDb(),
): Promise<VerifiableRole[]> => {
  const state = await readVerificationState(userId, db);
  if (!state) return [];
  const unverified: VerifiableRole[] = [];
  if (!state.candidateVerified) unverified.push("candidate");
  if (!state.recruiterVerified) unverified.push("recruiter");
  return unverified;
};

// Returns the single verified role on the account, or null if the account holds 0 or 2 verified
// roles. Used to drive: which dashboard the post-login redirect lands on for single-role
// accounts, and which dashboard "Skip for now" routes to.
export const getSoleVerifiedRole = async (
  userId: string,
  db: Database = getDb(),
): Promise<VerifiableRole | null> => {
  const state = await readVerificationState(userId, db);
  if (!state) return null;
  if (state.candidateVerified && !state.recruiterVerified) return "candidate";
  if (!state.candidateVerified && state.recruiterVerified) return "recruiter";
  return null;
};

// Returns true iff the post-login interstitial should fire this login session. Server-side
// logic only — never re-derive on the client. Dismissal carrier is the JWT-side
// `secondRolePromptDismissed` flag, set via useSession().update() when the user clicks
// "Skip for now"; the flag clears naturally on next sign-in because a fresh JWT is minted.
export const isSecondRoleVerificationPromptDue = async (
  userId: string,
  dismissedThisSession: boolean,
  db: Database = getDb(),
): Promise<boolean> => {
  if (dismissedThisSession) return false;
  const unverified = await getUnverifiedRoles(userId, db);
  // Prompt is due only when exactly one role remains unverified. Both-verified accounts have
  // no second role to prompt for; zero-verified accounts cannot exist (DB CHECK
  // users_one_verified_role_chk) but we fail-closed anyway.
  return unverified.length === 1;
};

export class RoleVerificationError extends Error {
  constructor(
    public readonly code:
      | "role_already_verified"
      | "invalid_role"
      | "user_not_found"
      | "candidate_profile_required"
      | "recruiter_verification_required",
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

// Flips the per-role `*_verified_at` timestamp together with that role's onboarding data, in one
// transaction. Guarded so it cannot re-verify an already-verified role.
//
// `candidateProfile` carries the four onboarding fields when a recruiter-first account verifies the
// candidate role here. It is written in the SAME transaction as the candidate verification grant, so
// this path never grants candidate access without an onboarding profile — parity with the
// credentials- and OAuth-signup candidacy paths. Required when `role === "candidate"`.
//
// `recruiterVerification` carries the recruiter affiliation form when a candidate-first account
// verifies the recruiter role here. The trust-verification submission is written in the SAME
// transaction as the recruiter grant, so the account enters the ops review queue immediately and
// stays sandboxed (tier `minimal`) until approved. Required when `role === "recruiter"`.
export const markRoleAsVerified = async (
  userId: string,
  role: VerifiableRole,
  candidateProfile: CandidateProfileInput | null,
  recruiterVerification: RecruiterVerificationInput | null,
  db: Database = getDb(),
): Promise<VerificationState> => {
  if (role === "candidate" && !candidateProfile) {
    throw new RoleVerificationError(
      "candidate_profile_required",
      400,
      "Candidate onboarding profile is required to verify the candidate role",
    );
  }

  if (role === "recruiter" && !recruiterVerification) {
    throw new RoleVerificationError(
      "recruiter_verification_required",
      400,
      "Recruiter affiliation form is required to verify the recruiter role",
    );
  }

  return db.transaction(async (tx) => {
    const current = await readVerificationState(userId, tx);

    if (!current) {
      throw new RoleVerificationError("user_not_found", 404, "User not found");
    }

    if (role === "candidate" && current.candidateVerified) {
      throw new RoleVerificationError(
        "role_already_verified",
        409,
        "Candidate role is already verified for this account",
      );
    }

    if (role === "recruiter" && current.recruiterVerified) {
      throw new RoleVerificationError(
        "role_already_verified",
        409,
        "Recruiter role is already verified for this account",
      );
    }

    // Step 4.0c (4.0c-M1 fix) — when the recruiter mode is flipped to verified, the recruiter
    // verification tier must be auto-granted to `minimal` in the SAME UPDATE statement. This
    // mirrors the credentials-auth signup path (`?as=recruiter`) and preserves the invariant
    // that any row holding `recruiterVerifiedAt IS NOT NULL` also holds tier >= `minimal`.
    // Without this atomic write, the second-role verification path leaves the user stranded at
    // tier='unverified' and locked out of opportunity creation.
    const verificationColumns =
      role === "candidate"
        ? { candidateVerifiedAt: sql`now()` }
        : {
            recruiterVerifiedAt: sql`now()`,
            recruiterVerificationTier: "minimal" as const,
          };

    await tx
      .update(users)
      .set({ ...verificationColumns, updatedAt: sql`now()` })
      .where(eq(users.id, userId));

    // Candidate onboarding profile lands in the SAME transaction as the candidate verification
    // grant, so a candidate account verified through this path always has its onboarding data.
    if (role === "candidate" && candidateProfile) {
      await insertCandidateProfileInTransaction(tx, userId, candidateProfile);
    }

    // Recruiter affiliation form lands in the SAME transaction as the recruiter grant, entering
    // the account into the platform-ops trust review queue.
    if (role === "recruiter" && recruiterVerification) {
      await createRecruiterVerificationSubmissionInTransaction(tx, userId, recruiterVerification);
    }

    logger.info("role_verification.completed", { userId, role });

    return {
      candidateVerified: current.candidateVerified || role === "candidate",
      recruiterVerified: current.recruiterVerified || role === "recruiter",
    };
  });
};

// Returns the verified-role's dashboard route. Falls back to /profile if neither role is
// verified (should not happen per DB CHECK, but fail-safe).
export const dashboardPathForRole = (role: VerifiableRole): string => {
  return role === "candidate" ? "/candidate-dashboard" : "/recruiter-dashboard";
};
