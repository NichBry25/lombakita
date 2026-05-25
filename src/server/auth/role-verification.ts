import { eq, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import { users } from "@/server/db/schema";
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
  return (
    typeof value === "string" && (VERIFIABLE_ROLES as readonly string[]).includes(value)
  );
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
      | "user_not_found",
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

// STUB: CCR-19 — verification mechanics deferred. The real verification path (form intake,
// document upload, ops review queue) lands in a later step. This stub flips the per-role
// `*_verified_at` timestamp directly so the rest of the role-mode plumbing can be exercised
// end-to-end. Guarded so it cannot re-verify an already-verified role.
export const markRoleAsVerifiedStub = async (
  userId: string,
  role: VerifiableRole,
  db: Database = getDb(),
): Promise<VerificationState> => {
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

    const column =
      role === "candidate"
        ? { candidateVerifiedAt: sql`now()` }
        : { recruiterVerifiedAt: sql`now()` };

    await tx
      .update(users)
      .set({ ...column, updatedAt: sql`now()` })
      .where(eq(users.id, userId));

    logger.info("role_verification.stub_completed", { userId, role });

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

// Pure decision function — given a verification state and the session's dismissal flag, returns
// where the post-login flow should land. Pulled out as a pure function so unit tests do not
// need a database. The caller is responsible for the DB read.
export const decidePostLoginDestination = (
  state: VerificationState,
  dismissedThisSession: boolean,
): string => {
  const verifiedCount =
    Number(state.candidateVerified) + Number(state.recruiterVerified);

  if (verifiedCount === 0) {
    // Should not happen — DB CHECK users_one_verified_role_chk guarantees at least one verified
    // role per account. Fail-closed by routing back to sign-in.
    return "/auth/sign-in";
  }

  if (verifiedCount === 2) {
    return "/candidate-dashboard";
  }

  // Single-role: candidate gets candidate dashboard, recruiter gets recruiter dashboard. If the
  // post-login prompt has not been dismissed this session, send through the interstitial first.
  const soleRole: VerifiableRole = state.candidateVerified ? "candidate" : "recruiter";

  if (!dismissedThisSession) {
    return "/auth/second-role-prompt";
  }

  return dashboardPathForRole(soleRole);
};
