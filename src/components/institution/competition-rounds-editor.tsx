"use client";

import { useCallback, useEffect, useState } from "react";
import { Feedback, FormInput, FormLabel, FormTextarea, IconButton, Panel } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  describePartLoadFailure,
  useCompetitionEditorPart,
  type CompetitionPartSaveResult,
} from "@/components/institution/competition-editor-parts";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";

const SAVE_ERROR_COPY: Partial<Record<string, string>> = {
  forbidden: "Anda tidak memiliki akses ke kompetisi institusi ini.",
  competition_rounds_invalid_payload:
    "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  competition_rounds_invalid_value:
    "Periksa data tahapan lalu coba lagi. Tanggal selesai tidak boleh sebelum tanggal mulai.",
};

const SAVE_FALLBACK = "Gagal menyimpan tahapan. Coba lagi.";

type RoundRow = {
  title: string;
  platformLabel: string;
  startsAt: string; // datetime-local value ("YYYY-MM-DDTHH:MM")
  endsAt: string;
  description: string;
};

type RoundsResponse = {
  rounds: Array<{
    title: string;
    platformLabel: string | null;
    startsAt: string | null;
    endsAt: string | null;
    description: string | null;
  }>;
};

// ISO instant → local datetime-local input value.
const toLocalInputValue = (iso: string | null): string => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// Local datetime-local input value → absolute ISO instant (or null when blank). Converting on the
// client keeps the instant unambiguous regardless of the server's timezone.
const toIsoOrNull = (localValue: string): string | null => {
  if (!localValue) return null;
  const date = new Date(localValue);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const emptyRow = (): RoundRow => ({
  title: "",
  platformLabel: "",
  startsAt: "",
  endsAt: "",
  description: "",
});

const isBlankRound = (row: RoundRow): boolean =>
  [row.title, row.platformLabel, row.startsAt, row.endsAt, row.description].every(
    (value) => value.trim() === "",
  );

const roundRowsEqual = (a: RoundRow[], b: RoundRow[]): boolean =>
  a.length === b.length &&
  a.every((row, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      row.title === other.title &&
      row.platformLabel === other.platformLabel &&
      row.startsAt === other.startsAt &&
      row.endsAt === other.endsAt &&
      row.description === other.description
    );
  });

export const CompetitionRoundsEditor = ({
  competitionId,
  expectedUserId,
}: {
  competitionId: string;
  expectedUserId: string;
}) => {
  const { addToast } = useToast();
  const [rows, setRows] = useState<RoundRow[]>([]);
  const [savedRows, setSavedRows] = useState<RoundRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);

  const loadRounds = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/competitions/${competitionId}/rounds`, {
        cache: "no-store",
        credentials: "include",
      });
      if (!response.ok) {
        addToast({ type: "error", message: "Gagal memuat tahapan." });
        return;
      }
      const { rounds } = (await response.json()) as RoundsResponse;
      const loadedRows = rounds.map((round) => ({
        title: round.title,
        platformLabel: round.platformLabel ?? "",
        startsAt: toLocalInputValue(round.startsAt),
        endsAt: toLocalInputValue(round.endsAt),
        description: round.description ?? "",
      }));
      setRows(loadedRows);
      setSavedRows(loadedRows);
      setHasLoaded(true);
    } catch {
      addToast({ type: "error", message: "Gagal memuat tahapan." });
    } finally {
      setIsLoading(false);
    }
  }, [competitionId, addToast]);

  useEffect(() => {
    void loadRounds();
  }, [loadRounds]);

  const updateRow = (index: number, patch: Partial<RoundRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const isDirty = !roundRowsEqual(rows, savedRows);

  const saveRounds = async (): Promise<CompetitionPartSaveResult> => {
    const sentRows = rows.filter((row) => !isBlankRound(row));
    if (sentRows.some((row) => row.title.trim() === "")) {
      return {
        ok: false,
        errorMessage: "Periksa data tahapan lalu coba lagi. Setiap tahapan wajib memiliki judul.",
      };
    }
    const rounds = sentRows.map((row) => ({
      title: row.title.trim(),
      platformLabel: row.platformLabel.trim() || null,
      startsAt: toIsoOrNull(row.startsAt),
      endsAt: toIsoOrNull(row.endsAt),
      description: row.description.trim() || null,
    }));

    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/rounds`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rounds }),
        },
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        return { ok: false, errorMessage: errorMessageFor(code, SAVE_ERROR_COPY, SAVE_FALLBACK) };
      }
      setRows(sentRows);
      setSavedRows(sentRows);
      await loadRounds();
      return { ok: true };
    } catch {
      return { ok: false, errorMessage: "Gagal menyimpan tahapan karena gangguan koneksi." };
    }
  };

  useCompetitionEditorPart("rounds", isDirty, saveRounds);

  return (
    <section className="content-section stack-md">
      <div className="stack-xs">
        <h2 className="section-title">Tahapan &amp; linimasa</h2>
        <p className="form-help">
          Tambahkan tahapan kompetisi berurutan. Bila kosong, halaman menampilkan jadwal
          pendaftaran.
        </p>
      </div>

      {isLoading ? (
        <p className="muted-copy">Memuat tahapan…</p>
      ) : !hasLoaded ? (
        <Feedback tone="error">{describePartLoadFailure("rounds")}</Feedback>
      ) : (
        <div className="stack-md">
          {rows.map((row, index) => (
            <Panel key={index} className="stack-sm">
              <div className="form-field">
                <FormLabel htmlFor={`round-title-${index}`} required>
                  Nama tahapan
                </FormLabel>
                <FormInput
                  id={`round-title-${index}`}
                  value={row.title}
                  maxLength={160}
                  onChange={(event) => updateRow(index, { title: event.target.value })}
                />
              </div>
              <div className="form-field">
                <FormLabel htmlFor={`round-platform-${index}`} optional>
                  Format (mis. Online / Offline)
                </FormLabel>
                <FormInput
                  id={`round-platform-${index}`}
                  value={row.platformLabel}
                  maxLength={80}
                  onChange={(event) => updateRow(index, { platformLabel: event.target.value })}
                />
              </div>
              <div className="form-field">
                <FormLabel htmlFor={`round-start-${index}`} optional>
                  Mulai
                </FormLabel>
                <FormInput
                  id={`round-start-${index}`}
                  type="datetime-local"
                  value={row.startsAt}
                  onChange={(event) => updateRow(index, { startsAt: event.target.value })}
                />
              </div>
              <div className="form-field">
                <FormLabel htmlFor={`round-end-${index}`} optional>
                  Selesai
                </FormLabel>
                <FormInput
                  id={`round-end-${index}`}
                  type="datetime-local"
                  value={row.endsAt}
                  onChange={(event) => updateRow(index, { endsAt: event.target.value })}
                />
              </div>
              <div className="form-field">
                <FormLabel htmlFor={`round-desc-${index}`} optional>
                  Deskripsi
                </FormLabel>
                <FormTextarea
                  id={`round-desc-${index}`}
                  rows={3}
                  value={row.description}
                  maxLength={2000}
                  onChange={(event) => updateRow(index, { description: event.target.value })}
                />
              </div>
              <IconButton
                icon="trash"
                label={`Hapus tahapan ${index + 1}`}
                variant="outline"
                className="remove-row-button"
                onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
              />
            </Panel>
          ))}

          <div className="cluster">
            <IconButton
              type="button"
              variant="outline"
              icon="plus"
              label="Tambah tahapan"
              onClick={() => setRows((prev) => [...prev, emptyRow()])}
            />
          </div>
        </div>
      )}
    </section>
  );
};
