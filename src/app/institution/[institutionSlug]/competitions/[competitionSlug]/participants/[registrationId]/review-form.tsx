"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CompetitionRegistrationReviewStatus } from "@/server/db/schema";
import { REVIEW_STATUS_LABELS, REVIEW_STATUS_ORDER } from "../review-status-labels";
import { useToast } from "@/components/ui/primitives";
import { Button, FormLabelText, FormTextarea, SelectField } from "@/components/ui";
import type { ReviewErrorCode } from "@/server/participants/review-service";

const REVIEW_ERROR_MESSAGES: Partial<Record<ReviewErrorCode, string>> = {
  review_registration_not_found: "Pendaftaran tidak ditemukan.",
  review_invalid_payload:
    "Tinjauan tidak dapat disimpan. Catatan internal paling banyak 5.000 karakter.",
};

async function readReviewErrorMessage(res: Response, fallback: string): Promise<string> {
  const body: { error?: { code?: ReviewErrorCode } } | null = await res.json().catch(() => null);
  const code = body?.error?.code;
  if (!code) return fallback;
  return REVIEW_ERROR_MESSAGES[code] ?? fallback;
}

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
        addToast({
          type: "error",
          message: await readReviewErrorMessage(res, "Gagal menyimpan. Coba lagi."),
        });
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
          <h2>Tinjauan peserta</h2>
        </div>
      </div>
      {registrationType === "team" && teamName && (
        <p className="participant-team-context">
          Tim: {teamName}
          {activeMemberCount !== null && (
            <span className="record-meta">({activeMemberCount} anggota aktif)</span>
          )}
        </p>
      )}
      <div className="form-field">
        <FormLabelText required>Status tinjauan</FormLabelText>
        <SelectField
          label="Status tinjauan"
          required
          value={status}
          onChange={(value) => setStatus(value as CompetitionRegistrationReviewStatus)}
          options={REVIEW_STATUS_ORDER.map((value) => ({
            value,
            label: REVIEW_STATUS_LABELS[value],
          }))}
        />
      </div>

      <label className="form-field">
        <FormLabelText optional>Catatan internal</FormLabelText>
        <FormTextarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={5}
          maxLength={5000}
        />
      </label>

      <div>
        <Button type="button" onClick={onSave} loading={saving}>
          Simpan tinjauan
        </Button>
      </div>
    </section>
  );
}
