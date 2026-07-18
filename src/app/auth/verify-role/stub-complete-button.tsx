"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui";
import type { VerifiableRole } from "@/server/auth/role-verification";
import { useToast } from "@/components/ui/primitives";

type StubCompleteButtonProps = {
  role: VerifiableRole;
};

// STUB: CCR-19 — verification mechanics deferred. This button calls the stub completion API
// and refreshes the session JWT so the new verifiedRoles entry is reflected without manual
// re-login. Real verification UX (form, document upload, ops review) is a later step.
export function StubCompleteButton({ role }: StubCompleteButtonProps) {
  const { update } = useSession();
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/v1/auth/verify-role", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message:
            payload?.error?.message ??
            "Stub verifikasi gagal. Periksa konsol server untuk detail lalu coba lagi.",
        });
        setBusy(false);
        return;
      }

      const payload = (await response.json()) as { redirectTo: string };

      // Refresh the JWT so the next page render sees the updated verifiedRoles. We MUST await
      // this before navigating — otherwise the destination dashboard's server-side check would
      // read a stale session.
      await update();

      window.location.assign(payload.redirectTo);
    } catch {
      addToast({
        type: "error",
        message:
          "Stub verifikasi gagal karena gangguan koneksi. Periksa jaringan Anda lalu coba lagi.",
      });
      setBusy(false);
    }
  };

  return (
    <Button type="button" onClick={onClick} disabled={busy} data-testid={`stub-complete-${role}`}>
      {busy ? "Memproses..." : "Selesaikan verifikasi (stub)"}
    </Button>
  );
}
