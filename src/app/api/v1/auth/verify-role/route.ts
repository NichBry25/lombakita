import { NextResponse } from "next/server";
import { assertSessionMatchesExpectedUser } from "@/server/auth/access-core";
import { withApiRole } from "@/server/auth/api-guard";
import {
  dashboardPathForRole,
  isVerifiableRole,
  markRoleAsVerified,
  RoleVerificationError,
  VERIFIABLE_ROLES,
} from "@/server/auth/role-verification";
import {
  CandidateProfileError,
  parseCandidateProfileInput,
  toCandidateProfileErrorResponse,
  type CandidateProfileInput,
} from "@/server/candidate/candidate-profile-core";

// Second-role verification. POST grants the requested role in one transaction: the candidate role
// with its onboarding profile, or the host role with no form. The answer says whether the account
// is a trusted host once the step commits.
//
// Note on path: the step prompt describes this as `POST /api/auth/verify-role`. The project's
// established API surface lives under `/api/v1/auth/...` (see /api/v1/auth/register,
// /api/v1/auth/session) and the bare `/api/auth/...` namespace is owned by next-auth's
// `[...nextauth]` catch-all. Mounting here keeps namespace ownership clean and matches the
// existing convention.
//
// Gated to the self-service roles: this endpoint grants a participant role, and only an account
// already acting as a candidate or recruiter may acquire the other one. An operational account
// carries participant verification timestamps from before it was promoted, but must not collect
// new ones — `sessionHasRole` suppresses the fold for operational roles, so it is refused here.
export const POST = withApiRole(VERIFIABLE_ROLES, async (request, session) => {
  assertSessionMatchesExpectedUser(request, session);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "invalid_payload",
          message: "Request body must be valid JSON with { role: 'candidate' | 'recruiter' }",
        },
      },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_payload",
          message: "Request body must be an object with a 'role' field",
        },
      },
      { status: 400 },
    );
  }

  const role = (body as { role?: unknown }).role;
  if (!isVerifiableRole(role)) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_role",
          message: "Field 'role' must be 'candidate' or 'recruiter'",
        },
      },
      { status: 400 },
    );
  }

  // Refuse a role the account already holds before parsing that role's onboarding payload, so the
  // caller is told the real reason (409 role_already_verified) rather than that its now-pointless
  // payload was malformed.
  //
  // Reading the session is sound here even though it is JWT-cached: verification timestamps are
  // only ever set, never cleared, so a cached list is stale-SMALLER. It can therefore miss a
  // just-granted role but can never claim one the account lacks. `markRoleAsVerified` still runs
  // the authoritative DB check and raises the same 409 on that path — this only moves the answer
  // earlier in the common case.
  if (Array.isArray(session.user.verifiedRoles) && session.user.verifiedRoles.includes(role)) {
    return NextResponse.json(
      {
        error: {
          code: "role_already_verified",
          message: `${role === "candidate" ? "Candidate" : "Recruiter"} role is already verified for this account`,
        },
      },
      { status: 409 },
    );
  }

  // Verifying the candidate role requires the onboarding profile in the same request, so the
  // profile and the candidate verification grant land in one transaction (parity with the
  // credentials- and OAuth-signup candidacy paths).
  let candidateProfile: CandidateProfileInput | null = null;
  if (role === "candidate") {
    try {
      candidateProfile = parseCandidateProfileInput(body);
    } catch (error) {
      if (error instanceof CandidateProfileError) {
        return toCandidateProfileErrorResponse(error);
      }
      throw error;
    }
  }

  try {
    const verification = await markRoleAsVerified(session.user.id, role, candidateProfile);
    return NextResponse.json({
      verified: role,
      redirectTo: dashboardPathForRole(role),
      hostTrusted: verification.hostTrusted,
    });
  } catch (error) {
    if (error instanceof RoleVerificationError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    throw error;
  }
});
