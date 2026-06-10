"use client";

import { useState } from "react";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";
import { useToast } from "@/components/ui/primitives";

type Props = {
  competitionId: string;
  initialSaved: boolean;
  expectedUserId: string;
};

export function SaveButton({ competitionId, initialSaved, expectedUserId }: Props) {
  const { addToast } = useToast();
  const [saved, setSaved] = useState(initialSaved);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    setLoading(true);
    const method = saved ? "DELETE" : "POST";
    try {
      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/save`,
        { method },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: { code?: string } };
        addToast({
          type: "error",
          message:
            body.error?.code === SESSION_MISMATCH_CODE
              ? SESSION_MISMATCH_MESSAGE
              : (body.error?.code ?? "Terjadi kesalahan. Coba lagi."),
        });
      } else {
        setSaved(!saved);
      }
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan. Coba lagi." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      style={{
        marginTop: 16,
        padding: "8px 20px",
        background: saved ? "#ECE5FF" : "#f4f4f4",
        color: saved ? "#355795" : "#333",
        border: "1px solid #ccc",
        borderRadius: 6,
        fontSize: 14,
        cursor: loading ? "wait" : "pointer",
      }}
    >
      {loading ? "..." : saved ? "✓ Disimpan" : "Simpan"}
    </button>
  );
}
