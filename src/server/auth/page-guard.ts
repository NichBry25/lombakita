import type { Session } from "next-auth";
import { redirect } from "next/navigation";
import { type AppRole, isSelfServiceRole, sessionHasRole } from "@/lib/access/roles";
import {
  AccessError,
  assertAuthenticatedSession,
  type AuthenticatedSession,
} from "@/server/auth/access-core";
import { getCurrentSession } from "@/server/auth/session";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/page-guard");

// Page renders go through the same session assertion as API routes, so the suspension gate and the
// stale-role-token rejection apply to what a visitor can SEE, not only to what they can submit.
// A suspended account holding a live cookie would otherwise keep rendering participant names and
// emails on every server component until its cookie expired.
const assertPageSession = (session: Session | null, loginPath: string): AuthenticatedSession => {
  try {
    return assertAuthenticatedSession(session);
  } catch (error) {
    if (!(error instanceof AccessError)) throw error;
    if (error.code === "account_suspended") {
      redirect("/suspended");
    }
    // A stale or unrecognised role token cannot be repaired by navigating — the visitor needs a
    // freshly minted JWT.
    redirect(loginPath);
  }
};

type RolePageGuardOptions = {
  // Where the visitor returns after signing in.
  callbackPath: string;
  // Where a self-service account that has not yet verified `role` is sent. Entry-point pages
  // offer the onboarding form; deep resource pages send the visitor home.
  missingRoleRedirect?: string;
};

// Single authorization predicate for every role-scoped page. Pages and API routes now ask the
// same question through the same function (`sessionHasRole`), so a surface can no longer render
// for a session whose requests that surface's endpoints will reject.
//
// `sessionHasRole` folds `verifiedRoles` only for self-service active roles, so an operational
// account never satisfies a participant gate here — matching `withApiRole` exactly.
//
// This answers authorization only. Onboarding state ("has this account completed candidate
// verification yet?") is a different question and is still read live from the database via
// `getUnverifiedRoles` — use that for banners and prompts, never as a gate.
export const requireRolePage = async (
  role: AppRole,
  { callbackPath, missingRoleRedirect = "/" }: RolePageGuardOptions,
): Promise<AuthenticatedSession> => {
  const loginPath = `/auth/login?callbackUrl=${encodeURIComponent(callbackPath)}`;
  const session = assertPageSession(await getCurrentSession(), loginPath);

  if (sessionHasRole(session.user.role, session.user.verifiedRoles, role)) {
    return session;
  }

  // Every account is created as a candidate or recruiter before being promoted, so an
  // operational account still carries participant verification timestamps it must not act on.
  // Sending it to the onboarding form would offer a role it is not allowed to hold; send it to
  // its own workspace instead, which is where it can actually do something.
  if (!isSelfServiceRole(session.user.role)) {
    redirect(session.user.role === "platform_ops" ? "/admin" : "/");
  }

  redirect(missingRoleRedirect);
};
