"use client";

import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";
import { SecondRolePromptModal } from "@/components/auth/second-role-prompt-modal";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { UIPrimitivesProvider } from "@/components/ui/primitives";

// Root-level next-auth SessionProvider. Required so client components that call
// `useSession()` (e.g. SkipForNowButton, VerifyRoleForm) can refresh the JWT via
// `update()` after the second-role verification flow. The provider does not pass an initial
// session — children call /api/auth/session lazily when they need it.
//
// SecondRolePromptModal is mounted globally so it can intercept any post-sign-in surface
// (after sign-in we now land on `/` rather than the dedicated prompt page). Modal is
// dismissible per-tab via sessionStorage; can be re-triggered from /profile via a custom event.
//
// UIPrimitivesProvider mounts ModalProvider + ToastProvider once at the root.
// All surfaces consume useModal / useToast from @/components/ui/primitives.
//
// PageTransitionProvider owns the blocking full-page loading screen shown while an action
// saves and then navigates. Surfaces consume usePageTransition from @/components/ui.
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <UIPrimitivesProvider>
        <PageTransitionProvider>
          {children}
          <SecondRolePromptModal />
        </PageTransitionProvider>
      </UIPrimitivesProvider>
    </SessionProvider>
  );
}
