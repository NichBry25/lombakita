"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CompetitionResultStatus } from "@/server/db/schema";
import { useToast } from "@/components/ui/primitives";

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
        body: JSON.stringify({ resultLabel: label.trim() || null, resultNotes: notes.trim() || null }),
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
    <div style={{ marginTop: 24, borderTop: "1px solid #ddd", paddingTop: 16 }}>
      <h2 style={{ marginBottom: 12 }}>Hasil kompetisi</h2>

      {registrationType === "team" && teamName && (
        <p style={{ margin: "0 0 12px", fontWeight: 600 }}>
          Tim: {teamName}
          {activeMemberCount !== null && (
            <span style={{ fontWeight: 400, marginLeft: 8, color: "#666" }}>
              ({activeMemberCount} anggota)
            </span>
          )}
          {registrationType === "team" && (
            <span style={{ fontWeight: 400, marginLeft: 8, color: "#666", fontSize: "0.9em" }}>
              — menerbitkan akan memperbarui semua anggota tim
            </span>
          )}
        </p>
      )}

      <p style={{ margin: "0 0 12px", color: status === "published" ? "#060" : "#888" }}>
        Status: <strong>{status === "published" ? "Dipublikasikan" : "Draf"}</strong>
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Label hasil (wajib sebelum publikasi)
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="cth. Juara 1, Finalis, Winner"
            disabled={status === "published"}
            style={{ padding: "6px 8px" }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Catatan hasil (opsional)
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            disabled={status === "published"}
            style={{ width: "100%" }}
          />
        </label>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {status === "draft" && (
            <>
              <button type="button" onClick={handleSaveDraft} disabled={saving}>
                {saving ? "Menyimpan…" : "Simpan draf"}
              </button>
              {(() => {
                const isDisabled = publishing || !label.trim();
                return (
                  <button
                    type="button"
                    onClick={handlePublish}
                    disabled={isDisabled}
                    style={{
                      background: isDisabled ? "#aaa" : "#355795",
                      color: "#fff",
                      border: "none",
                      padding: "6px 12px",
                      borderRadius: 4,
                      cursor: isDisabled ? "not-allowed" : "pointer",
                      opacity: isDisabled ? 0.65 : 1,
                    }}
                  >
                    {publishing ? "Menerbitkan…" : "Terbitkan"}
                  </button>
                );
              })()}
            </>
          )}
          {status === "published" && (
            <button
              type="button"
              onClick={handleUnpublish}
              disabled={unpublishing}
              style={{ background: "#c00", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 4, cursor: "pointer" }}
            >
              {unpublishing ? "Membatalkan…" : "Batalkan publikasi"}
            </button>
          )}
        </div>
      </div>

    </div>
  );
}
