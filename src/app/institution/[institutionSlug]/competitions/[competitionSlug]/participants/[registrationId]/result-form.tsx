"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CompetitionResultStatus } from "@/server/db/schema";
import type { ResultErrorCode } from "@/server/participants/result-service";
import { useToast } from "@/components/ui/primitives";
import { Button, FormInput, FormLabelText, FormTextarea } from "@/components/ui";

const RESULT_ERROR_MESSAGES: Partial<Record<ResultErrorCode, string>> = {
  result_registration_not_found: "Pendaftaran tidak ditemukan.",
  result_competition_cancelled:
    "Kompetisi ini dibatalkan, jadi hasilnya tidak dapat disimpan atau diterbitkan.",
  result_already_published: "Hasil sudah diterbitkan. Batalkan publikasi sebelum mengubahnya.",
  result_label_required: "Simpan label hasil sebagai draf sebelum menerbitkan.",
};

async function readResultErrorMessage(res: Response, fallback: string): Promise<string> {
  const body: { error?: { code?: ResultErrorCode } } | null = await res.json().catch(() => null);
  const code = body?.error?.code;
  if (!code) return fallback;
  return RESULT_ERROR_MESSAGES[code] ?? fallback;
}

type Props = {
  apiBasePath: string;
  initialStatus: CompetitionResultStatus;
  initialLabel: string | null;
  initialNotes: string | null;
  registrationType: "individual" | "team";
  teamName: string | null;
  activeMemberCount: number | null;
};

// Institution admin tooling acting on another user's registration — uses plain fetch.
// Per CLAUDE.md Rule #16 the cross-session session-match guard does NOT apply here.
export function ResultForm({
  apiBasePath,
  initialStatus,
  initialLabel,
  initialNotes,
  registrationType,
  teamName,
  activeMemberCount,
}: Props) {
  const router = useRouter();
  const { addToast } = useToast();
  const [label, setLabel] = useState<string>(initialLabel ?? "");
  const [notes, setNotes] = useState<string>(initialNotes ?? "");
  const [status, setStatus] = useState<CompetitionResultStatus>(initialStatus);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);

  const handleSaveDraft = async () => {
    setSaving(true);
    try {
      const res = await fetch(apiBasePath, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resultLabel: label.trim() || null,
          resultNotes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        addToast({
          type: "error",
          message: await readResultErrorMessage(res, "Gagal menyimpan. Coba lagi."),
        });
        return;
      }
      addToast({ type: "success", message: "Tersimpan sebagai draf." });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Gagal menyimpan: kesalahan jaringan" });
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    setPublishing(true);
    try {
      const res = await fetch(`${apiBasePath}/publish`, { method: "POST" });
      if (!res.ok) {
        addToast({
          type: "error",
          message: await readResultErrorMessage(res, "Gagal mempublikasikan. Coba lagi."),
        });
        return;
      }
      setStatus("published");
      addToast({ type: "success", message: "Hasil dipublikasikan." });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Gagal mempublikasikan: kesalahan jaringan" });
    } finally {
      setPublishing(false);
    }
  };

  const handleUnpublish = async () => {
    setUnpublishing(true);
    try {
      const res = await fetch(`${apiBasePath}/unpublish`, { method: "POST" });
      if (!res.ok) {
        addToast({
          type: "error",
          message: await readResultErrorMessage(res, "Gagal membatalkan publikasi. Coba lagi."),
        });
        return;
      }
      setStatus("draft");
      addToast({ type: "success", message: "Publikasi dibatalkan. Hasil kembali ke draf." });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Gagal membatalkan publikasi: kesalahan jaringan" });
    } finally {
      setUnpublishing(false);
    }
  };

  return (
    <section className="content-section participant-result-card">
      <div className="section-heading">
        <div>
          <h2>Hasil kompetisi</h2>
        </div>
        <span className="status-badge" data-status={status === "published" ? "open" : "awaiting"}>
          {status === "published" ? "Dipublikasikan" : "Draf"}
        </span>
      </div>

      {registrationType === "team" && teamName && (
        <p className="participant-team-context">
          Tim: {teamName}
          {activeMemberCount !== null && (
            <span className="record-meta">({activeMemberCount} anggota)</span>
          )}
          {registrationType === "team" && (
            <span className="record-meta">Menerbitkan akan memperbarui semua anggota tim.</span>
          )}
        </p>
      )}

      <div className="stack-md">
        <label className="form-field">
          <FormLabelText required>Label hasil</FormLabelText>
          <FormInput
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="cth. Juara 1, Finalis, Winner"
            disabled={status === "published"}
          />
          <span className="form-help">Wajib diisi sebelum publikasi.</span>
        </label>

        <label className="form-field">
          <FormLabelText optional>Catatan hasil</FormLabelText>
          <FormTextarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            disabled={status === "published"}
          />
        </label>

        <div className="record-actions">
          {status === "draft" && (
            <>
              <Button variant="outline" type="button" onClick={handleSaveDraft} loading={saving}>
                Simpan draf
              </Button>
              <Button
                type="button"
                onClick={handlePublish}
                loading={publishing}
                disabled={!label.trim()}
              >
                Terbitkan
              </Button>
            </>
          )}
          {status === "published" && (
            <Button
              variant="outline"
              type="button"
              onClick={handleUnpublish}
              loading={unpublishing}
            >
              Batalkan publikasi
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
