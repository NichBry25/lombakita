import type { DefaultSession } from "next-auth";
import type { AppRole } from "@/lib/access/roles";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: AppRole;
    };
  }

  interface User {
    role?: AppRole;
  }
}
