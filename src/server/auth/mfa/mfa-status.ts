import { isAppRole, isSelfServiceRole } from "@/lib/access/roles";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/mfa/mfa-status");

// The one place the three-state MFA gate is decided. Pure and deterministic given its inputs, so
// the removal-sensitive tests exercise this directly rather than only through the session plumbing
// around it.
//
//   not_applicable      — role is candidate/recruiter (isSelfServiceRole). MFA never applies.
//   enrolment_required   — role is operational (the negation of isSelfServiceRole — platform_ops,
//                          finance_ops, and reviewer_or_judge alike, by construction, never by a
//                          hardcoded role literal) and the account holds no VERIFIED factor.
//   challenge_required   — a verified factor exists, but the token carries no `mfaVerifiedAt` claim,
//                          or that claim is older than the account's live `mfa_invalidated_at`
//                          stamp. A token minted before this step existed carries no claim at all
//                          and lands here — it must fail closed, never satisfied.
//   satisfied             — a verified factor exists and the token's claim is at or after the live
//                          invalidation stamp.
export type MfaStatus =
  | "not_applicable"
  | "enrolment_required"
  | "challenge_required"
  | "satisfied";

export const resolveMfaStatus = (params: {
  role: string | undefined;
  hasVerifiedFactor: boolean;
  mfaInvalidatedAt: Date | null;
  // Unix seconds, as carried on the JWT (`token.mfaVerifiedAt`).
  tokenMfaVerifiedAtSeconds: number | undefined;
}): MfaStatus => {
  // An undefined or unrecognised role is not a KNOWN operational role — and a session in that state
  // is rejected upstream by normalizeSessionRole before any role gate is reached anyway. Requiring
  // isAppRole here (not just the isSelfServiceRole negation) keeps this fold honest on its own,
  // without depending on that upstream rejection to avoid mislabelling an absent role as
  // "enrolment_required".
  if (
    typeof params.role !== "string" ||
    !isAppRole(params.role) ||
    isSelfServiceRole(params.role)
  ) {
    return "not_applicable";
  }

  if (!params.hasVerifiedFactor) {
    return "enrolment_required";
  }

  if (typeof params.tokenMfaVerifiedAtSeconds !== "number") {
    return "challenge_required";
  }

  const claimedAtMs = params.tokenMfaVerifiedAtSeconds * 1000;
  const invalidatedAtMs = params.mfaInvalidatedAt?.getTime() ?? 0;

  if (claimedAtMs >= invalidatedAtMs) {
    return "satisfied";
  }

  return "challenge_required";
};
