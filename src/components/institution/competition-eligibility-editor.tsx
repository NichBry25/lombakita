"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckboxField, Feedback, FormLabel, FormLabelText, FormTextarea } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  describePartLoadFailure,
  useCompetitionEditorPart,
  type CompetitionPartSaveResult,
} from "@/components/institution/competition-editor-parts";
import { COMPETITION_AUDIENCE_OPTIONS, normalizeAudience } from "@/lib/competitions/audiences";
import { COMPETITION_CHANGED_DURING_EDIT_REASON } from "@/lib/competitions/publish-locks";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
import type { CompetitionAudience } from "@/server/db/schema";

const SAVE_ERROR_COPY: Partial<Record<string, string>> = {
  forbidden: "Anda tidak memiliki akses ke kompetisi institusi ini.",
  competition_eligibility_invalid_payload:
    "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  competition_eligibility_invalid_value:
    "Informasi kelayakan terlalu panjang. Persingkat lalu coba lagi.",
  competition_changed_during_edit: COMPETITION_CHANGED_DURING_EDIT_REASON,
};

const audienceKey = (values: readonly CompetitionAudience[]): string => values.join(",");

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
  const [savedNote, setSavedNote] = useState("");
  const [audience, setAudience] = useState<CompetitionAudience[]>([]);
  const [savedAudience, setSavedAudience] = useState<CompetitionAudience[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);

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
      const loaded = (await response.json()) as {
        eligibilityNote: string | null;
        audience: CompetitionAudience[] | null;
      };
      const loadedAudience = loaded.audience ?? [];
      setNote(loaded.eligibilityNote ?? "");
      setSavedNote(loaded.eligibilityNote ?? "");
      setAudience(loadedAudience);
      setSavedAudience(loadedAudience);
      setHasLoaded(true);
    } catch {
      addToast({ type: "error", message: "Gagal memuat informasi kelayakan." });
    } finally {
      setIsLoading(false);
    }
  }, [competitionId, addToast]);

  useEffect(() => {
    void loadNote();
  }, [loadNote]);

  const isDirty = note !== savedNote || audienceKey(audience) !== audienceKey(savedAudience);

  const toggleAudience = (value: CompetitionAudience, isTicked: boolean) => {
    const next = isTicked ? [...audience, value] : audience.filter((item) => item !== value);
    setAudience(normalizeAudience(next) ?? []);
  };

  const saveNote = async (): Promise<CompetitionPartSaveResult> => {
    const sentNote = note;
    const sentAudience = audience;
    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/eligibility`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ eligibilityNote: sentNote, audience: sentAudience }),
        },
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        return { ok: false, errorMessage: errorMessageFor(code, SAVE_ERROR_COPY, SAVE_FALLBACK) };
      }
      setSavedNote(sentNote);
      setSavedAudience(sentAudience);
      return { ok: true };
    } catch {
      return { ok: false, errorMessage: "Gagal menyimpan informasi karena gangguan koneksi." };
    }
  };

  useCompetitionEditorPart("eligibility", isDirty, saveNote);

  return (
    <section className="content-section stack-md">
      <div className="stack-xs">
        <h2 className="section-title">Kelayakan</h2>
        <p className="form-help">
          Informasi kelayakan bersifat deskriptif dan tidak membatasi siapa pun untuk mendaftar.
        </p>
      </div>

      {isLoading ? (
        <p className="muted-copy">Memuat…</p>
      ) : !hasLoaded ? (
        <Feedback tone="error">{describePartLoadFailure("eligibility")}</Feedback>
      ) : (
        <div className="stack-md">
          <fieldset className="form-field">
            <FormLabelText as="legend">Untuk</FormLabelText>
            <span className="form-help">
              Pilih satu atau lebih. Wajib diisi sebelum kompetisi diterbitkan.
            </span>
            {COMPETITION_AUDIENCE_OPTIONS.map((option) => (
              <CheckboxField
                key={option.value}
                id={`competition-audience-${option.value}`}
                checked={audience.includes(option.value)}
                onChange={(event) => toggleAudience(option.value, event.target.checked)}
              >
                {option.label}
              </CheckboxField>
            ))}
          </fieldset>
          <div className="form-field">
            <FormLabel htmlFor="competition-eligibility-note" optional>
              Catatan kelayakan
            </FormLabel>
            <FormTextarea
              id="competition-eligibility-note"
              rows={4}
              value={note}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>
      )}
    </section>
  );
};
