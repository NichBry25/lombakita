"use client";

import Link from "next/link";
import { useState } from "react";
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
  const [dismissed, setDismissed] = useState<boolean>(() =>
    readDismissedFromStorage(storageKey),
  );

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
    <div
      style={{
        border: "1px solid #c7d2fe",
        background: "#eef2ff",
        padding: "0.75rem 1rem",
        borderRadius: 6,
        marginBottom: "1rem",
        display: "flex",
        gap: "0.75rem",
        alignItems: "center",
        justifyContent: "space-between",
      }}
      data-testid="second-role-banner"
      data-role={unverifiedRole}
    >
      <span style={{ fontSize: "0.9rem" }}>{copy.headline}</span>
      <span style={{ display: "flex", gap: "0.5rem" }}>
        <Link
          href={`/auth/verify-role?as=${unverifiedRole}`}
          style={{
            padding: "0.35rem 0.85rem",
            background: "#355795",
            color: "#fff",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: "0.85rem",
          }}
        >
          {copy.cta}
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            padding: "0.35rem 0.6rem",
            background: "transparent",
            color: "#555",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: "0.85rem",
          }}
        >
          Tutup
        </button>
      </span>
    </div>
  );
}
