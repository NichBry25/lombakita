import type { DefaultSession } from "next-auth";
import type { AppRole } from "@/lib/access/roles";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: AppRole;
      verifiedRoles: AppRole[];
    };
    // Step 4.0b — JWT-carried flag set via useSession().update() when the user clicks
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
  }
}
