import { publicEnv } from "@/config/env";
import { serverEnv } from "@/config/env.server";

// Scaffolding only: Auth.js integration will be implemented in later steps.
export const authScaffoldConfig = {
  baseUrl: serverEnv.authUrl ?? publicEnv.appUrl,
  secretConfigured: Boolean(serverEnv.authSecret),
  providers: [],
} as const;
