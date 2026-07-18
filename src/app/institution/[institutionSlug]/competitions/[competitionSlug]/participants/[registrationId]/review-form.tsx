"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CompetitionRegistrationReviewStatus } from "@/server/db/schema";
import { REVIEW_STATUS_LABELS, REVIEW_STATUS_ORDER } from "../review-status-labels";
import { useToast } from "@/components/ui/primitives";
import { Button } from "@/components/ui";

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
  const { addToast } = useToast();
  const [status, setStatus] = useState<CompetitionRegistrationReviewStatus>(initialStatus);
  const [notes, setNotes] = useState<string>(initialNotes ?? "");
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    setSaving(true);
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
        addToast({ type: "error", message: `Gagal menyimpan: ${code}` });
        return;
      }
      addToast({ type: "success", message: "Tersimpan." });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Gagal menyimpan: kesalahan jaringan" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="content-section participant-review-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Penilaian internal</p>
          <h2>Tinjauan peserta</h2>
        </div>
        <span className="status-badge">{REVIEW_STATUS_LABELS[status]}</span>
      </div>
      {registrationType === "team" && teamName && (
        <p className="participant-team-context">
          Tim: {teamName}
          {activeMemberCount !== null && (
            <span className="record-meta">({activeMemberCount} anggota aktif)</span>
          )}
        </p>
      )}
      <label className="form-field">
        <span className="form-label">Status tinjauan</span>
        <select
          className="form-select"
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

      <label className="form-field">
        <span className="form-label">Catatan internal</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={5}
          className="form-textarea"
        />
      </label>

      <div>
        <Button type="button" onClick={onSave} disabled={saving} loading={saving}>
          {saving ? "Menyimpan…" : "Simpan tinjauan"}
        </Button>
      </div>
    </section>
  );
}
