import type { DefaultSession } from "next-auth";
import type { AppRole } from "@/lib/access/roles";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: AppRole;
      verifiedRoles: AppRole[];
      // ISO timestamp set by the session callback when the user's suspended_at is
      // non-null. Read by assertAuthenticatedSession to block the account (403 account_suspended).
      suspendedAt?: string;
    };
    // JWT-carried flag set via useSession().update() when the user clicks
    // "Skip for now" on the post-login second-role prompt. Clears naturally on next sign-in
    // because a fresh JWT is minted. Session-scoped only — never written to the database.
    secondRolePromptDismissed?: boolean;
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
  }
}
