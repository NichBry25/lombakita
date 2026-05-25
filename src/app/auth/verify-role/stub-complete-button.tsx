"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import type { VerifiableRole } from "@/server/auth/role-verification";

type StubCompleteButtonProps = {
  role: VerifiableRole;
};

// STUB: CCR-19 — verification mechanics deferred. This button calls the stub completion API
// and refreshes the session JWT so the new verifiedRoles entry is reflected without manual
// re-login. Real verification UX (form, document upload, ops review) is a later step.
export function StubCompleteButton({ role }: StubCompleteButtonProps) {
  const { update } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
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
        setError(
          payload?.error?.message ??
            "Stub verifikasi gagal. Periksa konsol server untuk detail lalu coba lagi.",
        );
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
      setError(
        "Stub verifikasi gagal karena gangguan koneksi. Periksa jaringan Anda lalu coba lagi.",
      );
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        data-testid={`stub-complete-${role}`}
        style={{
          padding: "0.6rem 1.25rem",
          background: "#355795",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: busy ? "wait" : "pointer",
          fontSize: "0.95rem",
        }}
      >
        {busy ? "Memproses..." : "Selesaikan verifikasi (stub)"}
      </button>
      {error ? (
        <p
          role="alert"
          style={{ color: "#b91c1c", fontSize: "0.85rem", marginTop: "0.5rem" }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
