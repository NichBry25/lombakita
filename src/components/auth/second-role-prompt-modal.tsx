"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import type { Session } from "next-auth";
import { isSelfServiceRole } from "@/lib/access/roles";
import { useModal } from "@/components/ui/primitives";

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

const secondRoleToOffer = (
  status: string,
  user: Session["user"] | undefined,
): "candidate" | "recruiter" | null => {
  if (status !== "authenticated" || !user) return null;

  // An operational account carries the participant verification it was created with, so it would
  // otherwise be offered the second role here, an offer the verify-role endpoint refuses.
  if (!isSelfServiceRole(user.role)) return null;

  const verified = Array.isArray(user.verifiedRoles) ? user.verifiedRoles : [];
  const verifiedRoleCandidates = verified.filter(isCandidateOrRecruiter);

  // Only single-verified-role accounts see the prompt. Dual-role and zero-role accounts skip.
  if (verifiedRoleCandidates.length !== 1) return null;

  return verifiedRoleCandidates[0] === "candidate" ? "recruiter" : "candidate";
};

// Mounted once in the root layout. It opens the canonical modal only when a component dispatches
// SHOW_SECOND_ROLE_PROMPT_EVENT on window, never on its own after a sign-in.
export function SecondRolePromptModal() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const { openModal, closeModal } = useModal();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(SHOW_SECOND_ROLE_PROMPT_EVENT, handler);
    return () => window.removeEventListener(SHOW_SECOND_ROLE_PROMPT_EVENT, handler);
  }, []);

  const offeredRole = secondRoleToOffer(status, session?.user);

  // openModal may not run during render. Opening here also lets a press made while the session
  // still loads open the pop-up once it has loaded.
  useEffect(() => {
    if (!open) return;
    // The pop-up closes when the session in this tab stops having a role to offer.
    if (offeredRole === null) {
      closeModal();
      return;
    }
    const copy = ROLE_COPY[offeredRole];
    openModal({
      title: copy.headline,
      body: copy.description,
      actions: [
        {
          label: copy.cta,
          variant: "primary",
          onClick: () => router.push(`/auth/verify-role?as=${offeredRole}`),
        },
        { label: "Nanti saja", variant: "secondary", onClick: () => {} },
      ],
      onClose: () => setOpen(false),
    });
  }, [open, offeredRole, openModal, closeModal, router]);

  return null;
}
