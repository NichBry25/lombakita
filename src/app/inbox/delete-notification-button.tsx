"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

// Step 6.5.1 — minimal-proof delete control for a notification. Mutates the caller's own data, so
// it uses `sessionFetch` (attaches X-Expected-User-Id; CLAUDE.md Rule #16). Errors render visibly.
export function DeleteNotificationButton({
  notificationId,
  expectedUserId,
}: {
  notificationId: string;
  expectedUserId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/me/notifications/${notificationId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const code = await readErrorCode(res);
        setError(
          code === SESSION_MISMATCH_CODE
            ? SESSION_MISMATCH_MESSAGE
            : `Gagal menghapus (${res.status}).`,
        );
        setPending(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Terjadi kesalahan jaringan. Coba lagi.");
      setPending(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button type="button" onClick={onClick} disabled={pending} style={{ fontSize: "0.85em" }}>
        {pending ? "Menghapus…" : "Hapus"}
      </button>
      {error ? <span style={{ color: "#b00020", fontSize: "0.8em" }}>{error}</span> : null}
    </span>
  );
}
