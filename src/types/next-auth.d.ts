import type { DefaultSession } from "next-auth";
import type { AppRole } from "@/lib/access/roles";
import type { MfaStatus } from "@/server/auth/mfa/mfa-status";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: AppRole;
      verifiedRoles: AppRole[];
      // ISO timestamp set by the session callback when the user's suspended_at is
      // non-null. Read by assertAuthenticatedSession to block the account (403 account_suspended).
      suspendedAt?: string;
      // Computed fresh every session resolution from a live DB read (never trusted
      // from the JWT alone) — "not_applicable" for candidate/recruiter, one of the other three for
      // every operational role. See mfa-status.ts for the fold and access-core.ts / page-guard.ts
      // for where it is enforced. Optional here (rather than required) purely so existing hand-
      // constructed mock sessions across the test suite keep typechecking without every one of
      // them being touched; `assertAuthenticatedSession` is what normalizes an absent value to
      // `"not_applicable"` — the real session callback below always sets a computed value, so this
      // is never actually absent outside a test fixture.
      mfaStatus?: MfaStatus;
    };
    // JWT-carried flag set via useSession().update() when the user clicks
    // "Skip for now" on the post-login second-role prompt. Clears naturally on next sign-in
    // because a fresh JWT is minted. Session-scoped only — never written to the database.
    secondRolePromptDismissed?: boolean;
    // Client → jwt-callback bridge. The client NEVER asserts `mfaVerified` directly —
    // it passes only this opaque grant id, minted server-side by the challenge/confirm routes after
    // a code has already been verified. The jwt callback's only trust decision is whether consuming
    // this id (server/auth/mfa/mfa-elevation.ts) returns the userId the token belongs to; the value
    // itself carries no authority on its own.
    mfaElevationGrant?: string;
  }

  interface User {
    role?: AppRole;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    secondRolePromptDismissed?: boolean;
    // Declared for type completeness. Suspension is resolved per-request in the
    // session callback via a live DB read (not carried on the JWT), so this is not populated.
    suspendedAt?: string;
    // Unix-seconds timestamp written ONLY by the jwt callback after a successful
    // server-side elevation-grant consume — never accepted as client input. Absent on every fresh
    // sign-in (an operational account always re-challenges on a new session) and cleared the moment
    // it is older than the account's `mfa_invalidated_at`, which mfa-status.ts's fold compares on
    // every session resolution.
    mfaVerifiedAt?: number;
  }
}
