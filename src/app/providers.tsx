"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

// Step 4.0b — root-level next-auth SessionProvider. Required so client components that call
// `useSession()` (e.g. SkipForNowButton, StubCompleteButton) can refresh the JWT via
// `update()` after the second-role verification flow. The provider does not pass an initial
// session — children call /api/auth/session lazily when they need it.
export function AppProviders({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
