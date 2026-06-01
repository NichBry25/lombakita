"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CompetitionRegistrationReviewStatus } from "@/server/db/schema";
import { REVIEW_STATUS_LABELS, REVIEW_STATUS_ORDER } from "../review-status-labels";

type Props = {
  apiPath: string;
  initialStatus: CompetitionRegistrationReviewStatus;
  initialNotes: string | null;
  registrationType: "individual" | "team";
  teamName: string | null;
  activeMemberCount: number | null;
};

// Institution admin tooling acting on another user's registration — uses plain fetch.
// Per CLAUDE.md Rule #16 the cross-session session-match guard does NOT apply here.
export function ReviewForm({
  apiPath,
  initialStatus,
  initialNotes,
  registrationType,
  teamName,
  activeMemberCount,
}: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<CompetitionRegistrationReviewStatus>(initialStatus);
  const [notes, setNotes] = useState<string>(initialNotes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await fetch(apiPath, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          internalReviewStatus: status,
          internalNotes: notes.trim() === "" ? null : notes,
        }),
      });
      if (!res.ok) {
        let code = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error?.code) code = body.error.code;
        } catch {
          // non-JSON error body — keep the status code
        }
        setError(`Gagal menyimpan: ${code}`);
        return;
      }
      setSuccess(true);
      router.refresh();
    } catch {
      setError("Gagal menyimpan: kesalahan jaringan");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      {registrationType === "team" && teamName && (
        <p style={{ margin: 0, fontWeight: 600 }}>
          Tim: {teamName}
          {activeMemberCount !== null && (
            <span style={{ fontWeight: 400, marginLeft: 8, color: "#666" }}>
              ({activeMemberCount} anggota aktif)
            </span>
          )}
        </p>
      )}
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Status tinjauan
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as CompetitionRegistrationReviewStatus)}
        >
          {REVIEW_STATUS_ORDER.map((value) => (
            <option key={value} value={value}>
              {REVIEW_STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Catatan internal
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={5}
          style={{ width: "100%" }}
        />
      </label>

      <div>
        <button type="button" onClick={onSave} disabled={saving}>
          {saving ? "Menyimpan…" : "Simpan tinjauan"}
        </button>
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {success && <p style={{ color: "green" }}>Tersimpan.</p>}
    </div>
  );
}
