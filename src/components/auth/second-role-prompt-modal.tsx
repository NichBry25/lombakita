"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { isSelfServiceRole } from "@/lib/access/roles";
import { Button, Icon } from "@/components/ui";

// Global event name. A component dispatches this on `window` to open the modal (the profile
// page's "Verifikasi sebagai ..." button does).
export const SHOW_SECOND_ROLE_PROMPT_EVENT = "lombakita:show-second-role-prompt";

const ROLE_COPY: Record<
  "candidate" | "recruiter",
  { headline: string; description: string; cta: string }
> = {
  candidate: {
    headline: "Verifikasi akun kandidat Anda",
    description:
      "Akun Anda saat ini hanya terverifikasi sebagai penyelenggara. Verifikasi sebagai kandidat untuk dapat mengikuti kompetisi.",
    cta: "Verifikasi sebagai kandidat",
  },
  recruiter: {
    headline: "Verifikasi akun penyelenggara Anda",
    description:
      "Akun Anda saat ini hanya terverifikasi sebagai kandidat. Verifikasi sebagai penyelenggara untuk dapat memposting peluang.",
    cta: "Verifikasi sebagai penyelenggara",
  },
};

const isCandidateOrRecruiter = (s: string): s is "candidate" | "recruiter" =>
  s === "candidate" || s === "recruiter";

// Global modal mounted in the root layout. It opens only when a component dispatches
// SHOW_SECOND_ROLE_PROMPT_EVENT on window, never on its own after a sign-in.
export function SecondRolePromptModal() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
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

  if (!open) return null;

  const verifiedRole = verifiedRoleCandidates[0];
  const unverifiedRole: "candidate" | "recruiter" =
    verifiedRole === "candidate" ? "recruiter" : "candidate";

  const onDismiss = () => {
    setOpen(false);
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
