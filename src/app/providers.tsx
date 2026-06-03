"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";
import { SecondRolePromptModal } from "@/components/auth/second-role-prompt-modal";
import { UIPrimitivesProvider } from "@/components/ui/primitives";

// Step 4.0b — root-level next-auth SessionProvider. Required so client components that call
// `useSession()` (e.g. SkipForNowButton, StubCompleteButton) can refresh the JWT via
// `update()` after the second-role verification flow. The provider does not pass an initial
// session — children call /api/auth/session lazily when they need it.
//
// SecondRolePromptModal is mounted globally so it can intercept any post-sign-in surface
// (after sign-in we now land on `/` rather than the dedicated prompt page). Modal is
// dismissible per-tab via sessionStorage; can be re-triggered from /profile via a custom event.
//
// UIPrimitivesProvider (Step 6.5.2) — mounts ModalProvider + ToastProvider once at the root.
// All surfaces consume useModal / useToast from @/components/ui/primitives.
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <UIPrimitivesProvider>
        {children}
        <SecondRolePromptModal />
      </UIPrimitivesProvider>
    </SessionProvider>
  );
}
