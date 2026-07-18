"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CompetitionResultStatus } from "@/server/db/schema";
import { useToast } from "@/components/ui/primitives";
import { Button } from "@/components/ui";

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
        const body = await res.json().catch(() => ({}));
        const code = (body as { error?: { code?: string } })?.error?.code ?? `HTTP ${res.status}`;
        addToast({ type: "error", message: `Gagal menyimpan: ${code}` });
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
        const body = await res.json().catch(() => ({}));
        const code = (body as { error?: { code?: string } })?.error?.code ?? `HTTP ${res.status}`;
        addToast({ type: "error", message: `Gagal mempublikasikan: ${code}` });
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
        const body = await res.json().catch(() => ({}));
        const code = (body as { error?: { code?: string } })?.error?.code ?? `HTTP ${res.status}`;
        addToast({ type: "error", message: `Gagal membatalkan publikasi: ${code}` });
        return;
      }
      setStatus("draft");
      addToast({ type: "success", message: "Publikasi dibatalkan — kembali ke draf." });
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
          <p className="eyebrow">Keluaran publik</p>
          <h2>Hasil kompetisi</h2>
        </div>
        <span className="status-badge" data-status={status === "published" ? "open" : "closing"}>
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
            <span className="record-meta">— menerbitkan akan memperbarui semua anggota tim</span>
          )}
        </p>
      )}

      <div className="stack-md">
        <label className="form-field">
          <span className="form-label form-label-required">Label hasil</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="cth. Juara 1, Finalis, Winner"
            disabled={status === "published"}
            className="form-input"
          />
          <span className="form-help">Wajib diisi sebelum publikasi.</span>
        </label>

        <label className="form-field">
          <span className="form-label">Catatan hasil (opsional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            disabled={status === "published"}
            className="form-textarea"
          />
        </label>

        <div className="record-actions">
          {status === "draft" && (
            <>
              <Button
                variant="outline"
                type="button"
                onClick={handleSaveDraft}
                disabled={saving}
                loading={saving}
              >
                {saving ? "Menyimpan…" : "Simpan draf"}
              </Button>
              {(() => {
                const isDisabled = publishing || !label.trim();
                return (
                  <Button
                    type="button"
                    onClick={handlePublish}
                    disabled={isDisabled}
                    loading={publishing}
                  >
                    {publishing ? "Menerbitkan…" : "Terbitkan"}
                  </Button>
                );
              })()}
            </>
          )}
          {status === "published" && (
            <Button
              variant="danger"
              type="button"
              onClick={handleUnpublish}
              disabled={unpublishing}
              loading={unpublishing}
            >
              {unpublishing ? "Membatalkan…" : "Batalkan publikasi"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
