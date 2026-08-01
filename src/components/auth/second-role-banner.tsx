"use client";

import { useState } from "react";
import { ButtonLink, Icon, IconButton } from "@/components/ui";
import type { VerifiableRole } from "@/server/auth/role-verification";

type SecondRoleBannerProps = {
  unverifiedRole: VerifiableRole;
  userId: string;
};

const COPY: Record<VerifiableRole, { headline: string; cta: string }> = {
  candidate: {
    headline: "Ingin ikut kompetisi sebagai mahasiswa? Verifikasi akun kandidat Anda.",
    cta: "Verifikasi kandidat",
  },
  recruiter: {
    headline: "Ingin mempublikasikan peluang? Verifikasi akun rekruter Anda.",
    cta: "Verifikasi rekruter",
  },
};

// Step 4.0b — dismissible second-role verification banner. Visibility decision is made on the
// server (the dashboard page only renders this when the second role is unverified). Dismissal
// is session-scoped via sessionStorage so a full page reload in the same tab preserves the
// dismissal, but a new browser session shows the banner again. Key includes userId so account
// switches do not inherit a previous user's dismissal.
const readDismissedFromStorage = (storageKey: string): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
};

export function SecondRoleBanner({ unverifiedRole, userId }: SecondRoleBannerProps) {
  const storageKey = `lombakita.banner.secondRole.dismissed.${userId}.${unverifiedRole}`;
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissedFromStorage(storageKey));

  if (dismissed) {
    return null;
  }

  const copy = COPY[unverifiedRole];

  const onDismiss = () => {
    try {
      window.sessionStorage.setItem(storageKey, "1");
    } catch {
      // sessionStorage unavailable — fall back to in-memory dismissal for this mount.
    }
    setDismissed(true);
  };

  return (
    <div className="second-role-banner" data-testid="second-role-banner" data-role={unverifiedRole}>
      <span className="second-role-banner-copy">
        <Icon name="user" size="md" />
        {copy.headline}
      </span>
      <span className="second-role-banner-actions">
        <ButtonLink href={`/auth/verify-role?as=${unverifiedRole}`} variant="primary" size="sm">
          {copy.cta}
        </ButtonLink>
        <IconButton icon="close" label="Tutup pemberitahuan" size="sm" onClick={onDismiss} />
      </span>
    </div>
  );
}
