"use client";

import { useState } from "react";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

type Props = {
  competitionId: string;
  initialSaved: boolean;
  expectedUserId: string;
};

export function SaveButton({ competitionId, initialSaved, expectedUserId }: Props) {
  const [saved, setSaved] = useState(initialSaved);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async () => {
    setLoading(true);
    setError(null);
    const method = saved ? "DELETE" : "POST";
    try {
      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/save`,
        { method },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: { code?: string } };
        if (body.error?.code === SESSION_MISMATCH_CODE) {
          setError(SESSION_MISMATCH_MESSAGE);
        } else {
          setError(body.error?.code ?? "Terjadi kesalahan. Coba lagi.");
        }
      } else {
        setSaved(!saved);
      }
    } catch {
      setError("Terjadi kesalahan. Coba lagi.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <button
        onClick={handleToggle}
        disabled={loading}
        style={{
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
      {error && <p style={{ fontSize: 12, color: "#c0392b", marginTop: 6 }}>{error}</p>}
    </div>
  );
}
