"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";
import { SecondRolePromptModal } from "@/components/auth/second-role-prompt-modal";

// Step 4.0b — root-level next-auth SessionProvider. Required so client components that call
// `useSession()` (e.g. SkipForNowButton, StubCompleteButton) can refresh the JWT via
// `update()` after the second-role verification flow. The provider does not pass an initial
// session — children call /api/auth/session lazily when they need it.
//
// SecondRolePromptModal is mounted globally so it can intercept any post-sign-in surface
// (after sign-in we now land on `/` rather than the dedicated prompt page). Modal is
// dismissible per-tab via sessionStorage; can be re-triggered from /profile via a custom event.
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      {children}
      <SecondRolePromptModal />
    </SessionProvider>
  );
}
