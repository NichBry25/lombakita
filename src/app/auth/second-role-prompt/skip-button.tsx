"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import type { VerifiableRole } from "@/server/auth/role-verification";

type SkipButtonProps = {
  destinationOnSkip: string;
  verifiedRole: VerifiableRole;
};

// Step 4.0b — "Skip for now" handler. Sets the session-scoped JWT flag via next-auth's
// update() trigger. The jwt callback in auth.config.ts intercepts the update and writes
// `secondRolePromptDismissed: true` onto the token; the flag clears naturally on next sign-in
// because a fresh JWT is minted then.
export function SkipForNowButton({ destinationOnSkip, verifiedRole }: SkipButtonProps) {
  const { update } = useSession();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await update({ secondRolePromptDismissed: true });
    } finally {
      window.location.assign(destinationOnSkip);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid={`skip-button-${verifiedRole}`}
      style={{
        padding: "0.6rem 1.25rem",
        background: "transparent",
        color: "#355795",
        border: "1px solid #355795",
        borderRadius: 6,
        cursor: busy ? "wait" : "pointer",
        fontSize: "0.95rem",
      }}
    >
      {busy ? "Memproses..." : "Lewati untuk sekarang"}
    </button>
  );
}
