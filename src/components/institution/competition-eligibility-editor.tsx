"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";

const SAVE_ERROR_COPY: Partial<Record<string, string>> = {
  forbidden: "Anda tidak memiliki akses ke kompetisi institusi ini.",
  competition_eligibility_invalid_payload:
    "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  competition_eligibility_invalid_value:
    "Informasi kelayakan terlalu panjang. Persingkat lalu coba lagi.",
};

const SAVE_FALLBACK = "Gagal menyimpan informasi. Coba lagi.";

export const CompetitionEligibilityEditor = ({
  competitionId,
  expectedUserId,
}: {
  competitionId: string;
  expectedUserId: string;
}) => {
  const { addToast } = useToast();
  const [note, setNote] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const loadNote = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/competitions/${competitionId}/eligibility`, {
        cache: "no-store",
        credentials: "include",
      });
      if (!response.ok) {
        addToast({ type: "error", message: "Gagal memuat informasi kelayakan." });
        return;
      }
      const { eligibilityNote } = (await response.json()) as { eligibilityNote: string | null };
      setNote(eligibilityNote ?? "");
    } catch {
      addToast({ type: "error", message: "Gagal memuat informasi kelayakan." });
    } finally {
      setIsLoading(false);
    }
  }, [competitionId, addToast]);

  useEffect(() => {
    void loadNote();
  }, [loadNote]);

  const saveNote = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/eligibility`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ eligibilityNote: note }),
        },
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        addToast({
          type: "error",
          message: errorMessageFor(code, SAVE_ERROR_COPY, SAVE_FALLBACK),
        });
        return;
      }
      addToast({ type: "success", message: "Informasi kelayakan berhasil disimpan." });
    } catch {
      addToast({ type: "error", message: "Gagal menyimpan informasi karena gangguan koneksi." });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="content-section surface-card card-padding stack-md">
      <div className="stack-xs">
        <h2 className="section-title">Kelayakan</h2>
        <p className="form-help">
          Informasi kelayakan bersifat deskriptif dan tidak membatasi siapa pun untuk mendaftar.
        </p>
      </div>

      {isLoading ? (
        <p className="muted-copy">Memuat…</p>
      ) : (
        <div className="stack-md">
          <div className="form-field">
            <label className="form-label" htmlFor="competition-eligibility-note">
              Catatan kelayakan
            </label>
            <textarea
              id="competition-eligibility-note"
              className="form-textarea"
              rows={4}
              value={note}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <Button type="button" onClick={saveNote} loading={isSaving}>
            Simpan
          </Button>
        </div>
      )}
    </section>
  );
};
