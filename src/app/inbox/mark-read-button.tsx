"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

// Step 6.5.1 — minimal-proof mark-as-read control for an unread notification. Mutates the caller's
// own data, so it uses `sessionFetch` (attaches X-Expected-User-Id; CLAUDE.md Rule #16). Errors are
// rendered visibly so the behaviour is manually verifiable.
export function MarkReadButton({
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
        `/api/v1/me/notifications/${notificationId}/read`,
        { method: "PATCH" },
      );
      if (!res.ok) {
        const code = await readErrorCode(res);
        setError(
          code === SESSION_MISMATCH_CODE
            ? SESSION_MISMATCH_MESSAGE
            : `Gagal menandai dibaca (${res.status}).`,
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
        {pending ? "Menandai…" : "Tandai dibaca"}
      </button>
      {error ? <span style={{ color: "#b00020", fontSize: "0.8em" }}>{error}</span> : null}
    </span>
  );
}
