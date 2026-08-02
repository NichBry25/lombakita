"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { isSelfServiceRole } from "@/lib/access/roles";
import { Button, Icon } from "@/components/ui";

// Global event name. Components can dispatch this on `window` to manually re-trigger the modal
// (e.g. a "Verifikasi peran lain" button on /profile).
export const SHOW_SECOND_ROLE_PROMPT_EVENT = "lombakita:show-second-role-prompt";

// sessionStorage key written by the sign-in form when a credentials sign-in succeeds. The modal
// only auto-shows when this flag is present, then clears it. This makes the modal appear once
// after a fresh sign-in and never again on subsequent navigations within the same tab. Set by
// `src/components/auth/auth-entry.tsx` right before the post-login redirect.
export const PENDING_PROMPT_KEY = "lombakita:second-role-prompt:pending";

const ROLE_COPY: Record<
  "candidate" | "recruiter",
  { headline: string; description: string; cta: string }
> = {
  candidate: {
    headline: "Verifikasi akun kandidat Anda",
    description:
      "Akun Anda saat ini hanya terverifikasi sebagai rekruter. Verifikasi sebagai kandidat untuk dapat mengikuti kompetisi sebagai mahasiswa.",
    cta: "Verifikasi sebagai kandidat",
  },
  recruiter: {
    headline: "Verifikasi akun rekruter Anda",
    description:
      "Akun Anda saat ini hanya terverifikasi sebagai kandidat. Verifikasi sebagai rekruter untuk dapat memposting peluang.",
    cta: "Verifikasi sebagai rekruter",
  },
};

const isCandidateOrRecruiter = (s: string): s is "candidate" | "recruiter" =>
  s === "candidate" || s === "recruiter";

// Global modal mounted in the root layout. Two ways it can open:
//   1. Automatic: only when the sign-in form writes the PENDING_PROMPT_KEY flag right after a
//      fresh credentials sign-in. Already-logged-in users opening the app or navigating around
//      do NOT trigger this — they have no pending flag.
//   2. Manual: when any component dispatches SHOW_SECOND_ROLE_PROMPT_EVENT on window (e.g. the
//      "Verifikasi sebagai X" button on /profile).
// Dismissing the modal clears the pending flag so it won't reappear on the next render.
export function SecondRolePromptModal() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  // Once we've reacted to the pending flag for this mount, don't react again. Re-reads on
  // session refresh would otherwise pop the dialog repeatedly.
  const consumedPendingFlag = useRef(false);

  // Auto-open trigger: read the pending flag once when the session becomes authenticated.
  // The lint rule discourages setState inside effects, but here we genuinely need to read
  // browser-only sessionStorage on mount and surface the decision. Server-rendered initial
  // value is false; the effect upgrades it on the client when the flag is present.
  useEffect(() => {
    if (status !== "authenticated") return;
    if (consumedPendingFlag.current) return;
    try {
      const pending = window.sessionStorage.getItem(PENDING_PROMPT_KEY);
      if (pending === "1") {
        consumedPendingFlag.current = true;
        window.sessionStorage.removeItem(PENDING_PROMPT_KEY);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setAutoOpen(true);
      }
    } catch {
      /* sessionStorage may be unavailable in private mode — ignore */
    }
  }, [status]);

  // Manual trigger via window event (used by the /profile button).
  useEffect(() => {
    const handler = () => setOverrideOpen(true);
    window.addEventListener(SHOW_SECOND_ROLE_PROMPT_EVENT, handler);
    return () => window.removeEventListener(SHOW_SECOND_ROLE_PROMPT_EVENT, handler);
  }, []);

  if (status !== "authenticated" || !session?.user) return null;

  // An operational account carries the participant verification it was created with, so it would
  // otherwise be offered the second role here — an offer the verify-role endpoint refuses.
  if (!isSelfServiceRole(session.user.role)) return null;

  const verified = Array.isArray(session.user.verifiedRoles) ? session.user.verifiedRoles : [];
  const verifiedRoleCandidates = verified.filter(isCandidateOrRecruiter);

  // Only single-verified-role accounts see the prompt. Dual-role and zero-role accounts skip.
  if (verifiedRoleCandidates.length !== 1) return null;

  const open = autoOpen || overrideOpen;
  if (!open) return null;

  const verifiedRole = verifiedRoleCandidates[0];
  const unverifiedRole: "candidate" | "recruiter" =
    verifiedRole === "candidate" ? "recruiter" : "candidate";

  const onDismiss = () => {
    setAutoOpen(false);
    setOverrideOpen(false);
  };

  const onVerify = () => {
    onDismiss();
    router.push(`/auth/verify-role?as=${unverifiedRole}`);
  };

  const copy = ROLE_COPY[unverifiedRole];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="second-role-prompt-title"
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="modal-dialog second-role-dialog">
        <span className="auth-state-icon" aria-hidden="true">
          <Icon name="user" size="lg" />
        </span>
        <div className="stack-xs">
          <h2 id="second-role-prompt-title" className="modal-title">
            {copy.headline}
          </h2>
          <p className="second-role-copy">{copy.description}</p>
        </div>
        <div className="modal-actions second-role-actions">
          <Button type="button" onClick={onVerify}>
            {copy.cta}
          </Button>
          <Button type="button" variant="outline" onClick={onDismiss}>
            Nanti saja
          </Button>
        </div>
      </div>
    </div>
  );
}
