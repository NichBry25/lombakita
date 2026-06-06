import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { decode as decodeNextAuthJwt } from "next-auth/jwt";
import { serverEnv } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import { accounts, userProfiles, users } from "@/server/db/schema";
import {
  deriveSignupRoleColumns,
  generateUniqueUsernameForName,
  isSignupRole,
  normalizeEmail,
  type SignupRole,
} from "@/server/auth/credentials-auth";
import {
  type GoogleIdentityClaims,
  signGoogleIdentityCarrier,
  verifyGoogleIdentityCarrier,
} from "@/server/auth/oauth-identity-carrier";
import { UsernameGenerationError } from "@/lib/username/generate";
import { claimPendingInvitationsForUser } from "@/server/invitations/claim-service";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/oauth-account");

export const GOOGLE_PROVIDER_ID = "google";
export const OAUTH_FINALIZE_PROVIDER_ID = "oauth-finalize";

// Step 6.5d — the deny destination for the safe-link fail-closed case. The login page renders a
// non-leaking notice for this `?error` value (it does not reveal whether an account exists or why
// linking was refused).
export const OAUTH_LINK_DENIED_ERROR = "oauth_link_denied";

// Critical defense against an upstream next-auth v4 footgun. When an OAuth callback arrives WITH
// a live JWT cookie present, next-auth's callback-handler.js loads `user = session.sub` and, for
// any OAuth account whose providerAccountId is not yet linked, runs `linkAccount({...account,
// userId: user.id})` BEFORE its own email lookup — silently attaching the new Google sub to
// whoever is currently signed in, regardless of the Google profile's email. That collapses into
// a permanent silent account takeover the next time the legitimate owner of that Google sub
// tries to sign in (the linked account now resolves to the attacker / wrong user).
//
// Our signIn callback intercepts first, so we refuse any OAuth flow whose resolved owner differs
// from the active session. The user is asked to sign out and retry. The login page renders a
// non-leaking notice for this `?error` value.
export const OAUTH_SESSION_MISMATCH_ERROR = "oauth_session_mismatch";

// Step 6.5d — controlled Google sign-in decision.
//
// next-auth v4's signIn callback fires BEFORE the adapter's createUser/linkAccount
// (core/routes/callback.js, verified against next-auth@4.24.13). Returning a string from signIn
// redirects the browser and SKIPS callbackHandler entirely — so for every case where we must NOT
// establish a session yet (defer creation / suspended / deny) we return a redirect and zero rows
// are written. Only the two "proceed" decisions let next-auth continue:
//   - existing_linked: a Google account row already exists → sign in as that user.
//   - link_existing:  an existing same-email account passed the safe-link gate → allowDangerous-
//                     EmailAccountLinking links the Google identity into it (no new users row).
export type GoogleSignInDecision =
  | { kind: "existing_linked"; userId: string; suspended: boolean }
  | { kind: "link_existing"; userId: string; suspended: boolean }
  | { kind: "link_denied" }
  | { kind: "new_user" };

export type GoogleSignInInput = {
  providerAccountId: string;
  email: string;
  googleEmailVerified: boolean;
};

// Resolves which of the three OAuth cases applies, fail-closed on the safe-link invariant.
//
// Suspension failure mode (consistent with the credentials login path, Step 6.5c): the suspension
// flag is read as part of the SAME user lookup this resolver already needs. A DB error therefore
// propagates out of signIn → next-auth redirects to /error → no session is issued (login denied).
// This matches "DB error at login time → login denied"; it does NOT change the per-request
// session-callback gate (loadSuspendedAt), which remains fail-open with the access-layer 403 as
// defense in depth.
export const resolveGoogleSignIn = async (
  input: GoogleSignInInput,
  db: Database = getDb(),
): Promise<GoogleSignInDecision> => {
  const email = normalizeEmail(input.email);

  // Case A — a Google account is already linked. Sign in as the owning user (suspension-gated).
  const [linked] = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, GOOGLE_PROVIDER_ID),
        eq(accounts.providerAccountId, input.providerAccountId),
      ),
    )
    .limit(1);

  if (linked) {
    const [owner] = await db
      .select({ id: users.id, suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.id, linked.userId))
      .limit(1);

    // A linked account whose user row vanished is anomalous — fail closed to deny rather than
    // create anything.
    if (!owner) {
      return { kind: "link_denied" };
    }

    return { kind: "existing_linked", userId: owner.id, suspended: owner.suspendedAt !== null };
  }

  // No Google account linked yet. Is there an existing account on this email?
  const [existing] = await db
    .select({
      id: users.id,
      emailVerified: users.emailVerified,
      suspendedAt: users.suspendedAt,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    // Safe-link invariant (account-takeover guard): link only when BOTH sides are positively
    // confirmed email-verified — Google's email_verified AND the existing account's own
    // emailVerified (set only after Resend confirmation for credentials accounts). If either side
    // is not positively verified, FAIL CLOSED: do not link, do not duplicate, deny.
    const bothSidesVerified = input.googleEmailVerified && existing.emailVerified !== null;

    if (!bothSidesVerified) {
      return { kind: "link_denied" };
    }

    return {
      kind: "link_existing",
      userId: existing.id,
      suspended: existing.suspendedAt !== null,
    };
  }

  // Brand-new Google user — defer creation to the role-picker round trip. Zero rows written.
  return { kind: "new_user" };
};

export class OAuthFinalizeError extends Error {
  constructor(
    public readonly code: "invalid_carrier" | "invalid_role" | "account_conflict",
    message: string,
  ) {
    super(message);
    this.name = "OAuthFinalizeError";
  }
}

type FinalizeResult = { id: string; email: string; role: SignupRole };

// Step 6.5d — transactional creation for a brand-new Google user after the role is declared.
//
// Creates users + accounts(google) + username + profile shell + role verification + recruiter tier
// in ONE transaction, reusing the shared credentials-signup primitives (deriveSignupRoleColumns,
// generateUniqueUsernameForName) so role/tier/username semantics are identical to a credentials
// signup. Verification is sourced from the DECLARED role only; Google's email_verified is used
// solely to set the Auth.js `users.emailVerified` column (account-email confirmation), never as a
// candidate/recruiter verification timestamp.
//
// The accounts row is inserted directly (not via the adapter linkAccount) because the post-creation
// session is minted through the `oauth-finalize` credentials provider, not the OAuth callback. Only
// the identity columns (type/provider/providerAccountId) are stored — no Google API tokens are
// persisted, as this step performs authentication only.
export const finalizeOAuthSignup = async (
  claims: GoogleIdentityClaims,
  signupRole: SignupRole,
  db: Database = getDb(),
): Promise<FinalizeResult> => {
  const email = normalizeEmail(claims.email);

  try {
    return await db.transaction(async (tx) => {
      // Idempotency / race guard: if this Google identity is already linked (e.g. a replayed
      // carrier, or a concurrent finalize that already landed), sign in as the existing owner
      // rather than creating a duplicate.
      const [linked] = await tx
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(
          and(
            eq(accounts.provider, GOOGLE_PROVIDER_ID),
            eq(accounts.providerAccountId, claims.providerAccountId),
          ),
        )
        .limit(1);

      if (linked) {
        const [owner] = await tx
          .select({ id: users.id, email: users.email, role: users.role })
          .from(users)
          .where(eq(users.id, linked.userId))
          .limit(1);
        if (!owner) {
          throw new OAuthFinalizeError("account_conflict", "Linked account owner not found");
        }
        const ownerRole: SignupRole = owner.role === "recruiter" ? "recruiter" : "candidate";
        return { id: owner.id, email: owner.email, role: ownerRole };
      }

      // An existing account on this email with no linked Google identity must NOT be created over
      // or silently linked here — that path is the safe-link decision in resolveGoogleSignIn. If we
      // see one at finalize time it is a race or a forged-flow attempt; fail closed.
      const [existingByEmail] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existingByEmail) {
        throw new OAuthFinalizeError(
          "account_conflict",
          "An account with this email already exists",
        );
      }

      const now = new Date();
      const roleColumns = deriveSignupRoleColumns(signupRole, now);

      const username = await generateUniqueUsernameForName(
        claims.name && claims.name.trim().length > 0 ? claims.name : email,
        async (candidate) => {
          const [taken] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.username, candidate))
            .limit(1);
          return !taken;
        },
      );

      const [inserted] = await tx
        .insert(users)
        .values({
          email,
          name: claims.name,
          image: claims.image,
          username,
          // Auth.js account-email confirmation column. Google verified the address (we only reach
          // finalize for a new user; email_verified is carried for completeness). This is NOT a
          // role-verification timestamp.
          emailVerified: claims.emailVerified ? now : null,
          ...roleColumns,
        })
        .returning({ id: users.id, email: users.email });

      const userId = inserted?.id;
      if (!userId) {
        throw new OAuthFinalizeError("account_conflict", "Failed to create account");
      }

      await tx
        .insert(userProfiles)
        .values({ userId, displayName: claims.name })
        .onConflictDoNothing();

      await tx
        .insert(accounts)
        .values({
          userId,
          type: "oauth",
          provider: GOOGLE_PROVIDER_ID,
          providerAccountId: claims.providerAccountId,
        })
        .onConflictDoNothing();

      // Step 6.5e — claim-at-signup for a brand-new Google user, gated on POSITIVE email
      // verification (6.5e-D1). Claim fires ONLY when Google asserts `email_verified` — the same
      // verified-email-ownership boundary the credentials path enforces (an unverified email never
      // claims). When Google returns email_verified=false the account is created with
      // `users.emailVerified` null (line above) and no invite is attached. Runs inside the same
      // transaction that finalizes the account (no half-claimed state).
      if (claims.emailVerified) {
        await claimPendingInvitationsForUser(userId, email, tx, now);
      }

      logger.info("oauth.signup.finalized", { userId, role: signupRole });

      return { id: userId, email: inserted.email, role: signupRole };
    });
  } catch (error) {
    if (error instanceof OAuthFinalizeError) {
      throw error;
    }
    if (error instanceof UsernameGenerationError) {
      logger.error("oauth.signup.username_exhausted", { email });
      throw new OAuthFinalizeError("account_conflict", "Account could not be created right now");
    }
    // A unique-violation race (email or Google account created concurrently) collapses to a
    // conflict rather than a duplicate.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      logger.warn("oauth.signup.conflict", { email });
      throw new OAuthFinalizeError("account_conflict", "Account could not be created right now");
    }
    throw error;
  }
};

// Step 6.5d — authorize() body for the `oauth-finalize` credentials provider. Verifies the
// integrity-protected carrier (tampered/expired → reject), validates the declared role, finalizes
// account creation, and returns the user object so next-auth mints a JWT session indistinguishable
// from a credentials session. The carrier is the trust anchor: it is the server's own
// HMAC-signed attestation that Google authenticated this identity, so authorize trusts its email /
// providerAccountId. A caller cannot forge one without AUTH_SECRET.
export const authorizeOAuthFinalize = async (
  credentials: Record<string, unknown> | undefined,
  db: Database = getDb(),
): Promise<{ id: string; email: string; role: SignupRole }> => {
  const claims = verifyGoogleIdentityCarrier(credentials?.carrier);
  if (!claims) {
    throw new OAuthFinalizeError("invalid_carrier", "OAuth identity carrier is invalid or expired");
  }

  const role = credentials?.role;
  if (!isSignupRole(role)) {
    throw new OAuthFinalizeError("invalid_role", "A valid role declaration is required");
  }

  return finalizeOAuthSignup(claims, role, db);
};

// Redirect base for the signIn-callback interception. signIn can only abort the OAuth flow by
// returning a redirect string, so these are the only surfaces a non-proceeding Google sign-in can
// land on. An absolute URL is preferred (built from the configured app base); when no base is
// configured (only in tests) a relative path is returned, which browsers still resolve.
const oauthRedirectBase = (): string => serverEnv.appBaseUrl ?? serverEnv.authUrl ?? "";

const toRedirect = (path: string): string => {
  const base = oauthRedirectBase();
  return base ? `${base}${path}` : path;
};

const SUSPENDED_REDIRECT = "/suspended";
const LINK_DENIED_REDIRECT = `/auth/login?error=${OAUTH_LINK_DENIED_ERROR}`;
const SESSION_MISMATCH_REDIRECT = `/auth/login?error=${OAUTH_SESSION_MISMATCH_ERROR}`;
// Step 6.5d.1 — the brand-new-Google-user role picker now lives on the single method-first
// `/auth/login` page (the `/auth/register` route was merged into it). `/auth/login?oauth=<carrier>`
// renders the OAuth role picker server-side after verifying the carrier.
const rolePickerRedirect = (carrier: string): string =>
  `/auth/login?oauth=${encodeURIComponent(carrier)}`;

// next-auth v4 cookie names. Dev (http) writes `next-auth.session-token`; production (https)
// writes `__Secure-next-auth.session-token`. We check both rather than branching on env so a
// misconfigured runtime (e.g. NEXTAUTH_URL mismatch) cannot accidentally skip the gate.
const NEXTAUTH_SESSION_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
] as const;

// Returns the user id encoded in the live JWT session cookie, or null when:
//   - no session cookie is present
//   - the cookie cannot be decoded (signature mismatch / expired / malformed)
//   - the decoded token has no `sub`
// We fail-open on decode error: an undecodable cookie is treated as "no session" because we
// cannot attribute it to any specific user. The downstream OAuth flow remains safe — if no
// active session is detectable, next-auth's callback-handler will fall through to its
// email-match path, which our signIn callback already governs via resolveGoogleSignIn.
export const readActiveSessionUserId = async (): Promise<string | null> => {
  let cookieStore: Awaited<ReturnType<typeof cookies>>;
  try {
    cookieStore = await cookies();
  } catch {
    // cookies() throws when invoked outside a Next.js request scope (e.g. unit tests). The
    // caller treats null as "no session" — safe because tests stub readActiveSessionUserId
    // explicitly when they want to exercise the active-session branches.
    return null;
  }

  const secret = serverEnv.authSecret;
  if (!secret) {
    return null;
  }

  for (const name of NEXTAUTH_SESSION_COOKIE_NAMES) {
    const value = cookieStore.get(name)?.value;
    if (!value) continue;
    try {
      const token = await decodeNextAuthJwt({ token: value, secret });
      if (token && typeof token.sub === "string" && token.sub.length > 0) {
        return token.sub;
      }
    } catch {
      // Try the next candidate cookie name; if all fail we return null.
    }
  }
  return null;
};

export type GoogleOAuthSignInParams = {
  providerAccountId: string;
  email: string | null | undefined;
  googleEmailVerified: boolean;
  name: string | null;
  image: string | null;
};

// Step 6.5d — full signIn-callback outcome for a Google sign-in: `true` to let next-auth proceed
// (establish the session for an existing linked account or safe-link an existing same-email
// account), or a redirect string that ABORTS the flow before any DB write (suspended → /suspended,
// fail-closed deny → login notice, brand-new user → role picker carrying the signed identity).
//
// Cross-session takeover guard: if a JWT session is already present in the browser, returning
// `true` for the OAuth flow lets next-auth's callback-handler.js silently link the new
// providerAccountId to the CURRENT session user (instead of the email-matched user), permanently
// hijacking the Google identity. We therefore refuse the flow whenever the resolved owner differs
// from the active session, and ALSO refuse new-user signup while any session is active (to avoid
// confusing implicit account-switch UX).
export const resolveGoogleOAuthSignIn = async (
  params: GoogleOAuthSignInParams,
  db: Database = getDb(),
): Promise<true | string> => {
  // Google did not return an email — we can neither link nor safely create. Fail closed.
  if (!params.email) {
    logger.warn("oauth.signin.no_email", { providerAccountId: params.providerAccountId });
    return toRedirect(LINK_DENIED_REDIRECT);
  }

  const [decision, activeUserId] = await Promise.all([
    resolveGoogleSignIn(
      {
        providerAccountId: params.providerAccountId,
        email: params.email,
        googleEmailVerified: params.googleEmailVerified,
      },
      db,
    ),
    readActiveSessionUserId(),
  ]);

  switch (decision.kind) {
    case "existing_linked":
    case "link_existing": {
      if (decision.suspended) {
        return toRedirect(SUSPENDED_REDIRECT);
      }
      // If a different user is already signed in, REFUSE. Allowing the flow lets next-auth's
      // callback-handler attach the new providerAccountId to the active user when the link is
      // not yet established (link_existing), or throw AccountNotLinkedError when it is
      // (existing_linked with mismatched session). Either way the user is confused; we surface
      // a clean "sign out first" instruction.
      if (activeUserId && activeUserId !== decision.userId) {
        logger.warn("oauth.signin.session_user_mismatch", {
          activeUserId,
          targetUserId: decision.userId,
          providerAccountId: params.providerAccountId,
        });
        return toRedirect(SESSION_MISMATCH_REDIRECT);
      }
      return true;
    }
    case "link_denied":
      return toRedirect(LINK_DENIED_REDIRECT);
    case "new_user": {
      // Brand-new-user signup while another session is active would surprise the operator
      // (Google picker auto-selected an unexpected identity while signed in). Refuse and ask
      // them to sign out first; this is the same UX guarantee as the link_existing branch
      // above and avoids implicit account-switching.
      if (activeUserId) {
        logger.warn("oauth.signin.new_user_blocked_by_active_session", {
          activeUserId,
          providerAccountId: params.providerAccountId,
        });
        return toRedirect(SESSION_MISMATCH_REDIRECT);
      }
      const carrier = signGoogleIdentityCarrier({
        provider: "google",
        providerAccountId: params.providerAccountId,
        email: normalizeEmail(params.email),
        emailVerified: params.googleEmailVerified,
        name: params.name,
        image: params.image,
      });
      return toRedirect(rolePickerRedirect(carrier));
    }
  }
};
