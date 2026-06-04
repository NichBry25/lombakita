import { and, eq } from "drizzle-orm";
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
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/auth/oauth-account");

export const GOOGLE_PROVIDER_ID = "google";
export const OAUTH_FINALIZE_PROVIDER_ID = "oauth-finalize";

// Step 6.5d — the deny destination for the safe-link fail-closed case. The login page renders a
// non-leaking notice for this `?error` value (it does not reveal whether an account exists or why
// linking was refused).
export const OAUTH_LINK_DENIED_ERROR = "oauth_link_denied";

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
// Step 6.5d.1 — the brand-new-Google-user role picker now lives on the single method-first
// `/auth/login` page (the `/auth/register` route was merged into it). `/auth/login?oauth=<carrier>`
// renders the OAuth role picker server-side after verifying the carrier.
const rolePickerRedirect = (carrier: string): string =>
  `/auth/login?oauth=${encodeURIComponent(carrier)}`;

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
export const resolveGoogleOAuthSignIn = async (
  params: GoogleOAuthSignInParams,
  db: Database = getDb(),
): Promise<true | string> => {
  // Google did not return an email — we can neither link nor safely create. Fail closed.
  if (!params.email) {
    logger.warn("oauth.signin.no_email", { providerAccountId: params.providerAccountId });
    return toRedirect(LINK_DENIED_REDIRECT);
  }

  const decision = await resolveGoogleSignIn(
    {
      providerAccountId: params.providerAccountId,
      email: params.email,
      googleEmailVerified: params.googleEmailVerified,
    },
    db,
  );

  switch (decision.kind) {
    case "existing_linked":
    case "link_existing":
      return decision.suspended ? toRedirect(SUSPENDED_REDIRECT) : true;
    case "link_denied":
      return toRedirect(LINK_DENIED_REDIRECT);
    case "new_user": {
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
