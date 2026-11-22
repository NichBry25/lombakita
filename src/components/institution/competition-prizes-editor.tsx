"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckboxField,
  Feedback,
  FormInput,
  FormLabel,
  FormTextarea,
  IconButton,
  Panel,
} from "@/components/ui";
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
  competition_prizes_invalid_payload:
    "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  competition_prizes_invalid_value: "Periksa data hadiah lalu coba lagi.",
};

const SAVE_FALLBACK = "Gagal menyimpan hadiah. Coba lagi.";

type PrizeRow = {
  rankLabel: string;
  title: string;
  cashAmount: string;
  isCertificate: boolean;
  description: string;
};

type PrizesResponse = {
  prizes: Array<{
    rankLabel: string | null;
    title: string;
    cashAmount: string | null;
    isCertificate: boolean;
    description: string | null;
  }>;
};

const emptyRow = (): PrizeRow => ({
  rankLabel: "",
  title: "",
  cashAmount: "",
  isCertificate: false,
  description: "",
});

const isBlankPrize = (row: PrizeRow): boolean =>
  !row.isCertificate &&
  [row.rankLabel, row.title, row.cashAmount, row.description].every((value) => value.trim() === "");

const prizeRowsEqual = (a: PrizeRow[], b: PrizeRow[]): boolean =>
  a.length === b.length &&
  a.every((row, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      row.rankLabel === other.rankLabel &&
      row.title === other.title &&
      row.cashAmount === other.cashAmount &&
      row.isCertificate === other.isCertificate &&
      row.description === other.description
    );
  });

export const CompetitionPrizesEditor = ({
  competitionId,
  expectedUserId,
}: {
  competitionId: string;
  expectedUserId: string;
}) => {
  const { addToast } = useToast();
  const [rows, setRows] = useState<PrizeRow[]>([]);
  const [savedRows, setSavedRows] = useState<PrizeRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);

  const loadPrizes = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/competitions/${competitionId}/prizes`, {
        cache: "no-store",
        credentials: "include",
      });
      if (!response.ok) {
        addToast({ type: "error", message: "Gagal memuat hadiah." });
        return;
      }
      const { prizes } = (await response.json()) as PrizesResponse;
      const loadedRows = prizes.map((prize) => ({
        rankLabel: prize.rankLabel ?? "",
        title: prize.title,
        cashAmount: prize.cashAmount ?? "",
        isCertificate: prize.isCertificate,
        description: prize.description ?? "",
      }));
      setRows(loadedRows);
      setSavedRows(loadedRows);
      setHasLoaded(true);
    } catch {
      addToast({ type: "error", message: "Gagal memuat hadiah." });
    } finally {
      setIsLoading(false);
    }
  }, [competitionId, addToast]);

  useEffect(() => {
    void loadPrizes();
  }, [loadPrizes]);

  const updateRow = (index: number, patch: Partial<PrizeRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const isDirty = !prizeRowsEqual(rows, savedRows);

  const savePrizes = async (): Promise<CompetitionPartSaveResult> => {
    const sentRows = rows.filter((row) => !isBlankPrize(row));
    if (sentRows.some((row) => row.title.trim() === "")) {
      return {
        ok: false,
        errorMessage: "Periksa data hadiah lalu coba lagi. Setiap hadiah wajib memiliki judul.",
      };
    }
    if (sentRows.some((row) => row.cashAmount.trim() === "" && !row.isCertificate)) {
      return {
        ok: false,
        errorMessage:
          "Periksa data hadiah lalu coba lagi. Setiap hadiah wajib memiliki nominal tunai atau sertifikat.",
      };
    }
    const prizes = sentRows.map((row) => ({
      rankLabel: row.rankLabel.trim() || null,
      title: row.title.trim(),
      cashAmount: row.cashAmount.trim() ? Number(row.cashAmount) : null,
      isCertificate: row.isCertificate,
      description: row.description.trim() || null,
    }));

    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/prizes`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prizes }),
        },
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        return { ok: false, errorMessage: errorMessageFor(code, SAVE_ERROR_COPY, SAVE_FALLBACK) };
      }
      setRows(sentRows);
      setSavedRows(sentRows);
      await loadPrizes();
      return { ok: true };
    } catch {
      return { ok: false, errorMessage: "Gagal menyimpan hadiah karena gangguan koneksi." };
    }
  };

  useCompetitionEditorPart("prizes", isDirty, savePrizes);

  return (
    <section className="content-section stack-md">
      <div className="stack-xs">
        <h2 className="section-title">Hadiah</h2>
        <p className="form-help">
          Tambahkan hadiah kompetisi. Nominal tunai hanya ditampilkan, karena pembayaran belum
          aktif.
        </p>
      </div>

      {isLoading ? (
        <p className="muted-copy">Memuat hadiah…</p>
      ) : !hasLoaded ? (
        <Feedback tone="error">{describePartLoadFailure("prizes")}</Feedback>
      ) : (
        <div className="stack-md">
          {rows.map((row, index) => (
            <Panel key={index} className="stack-sm">
              <div className="form-field">
                <FormLabel htmlFor={`prize-rank-${index}`} optional>
                  Tingkat (mis. Juara 1)
                </FormLabel>
                <FormInput
                  id={`prize-rank-${index}`}
                  value={row.rankLabel}
                  maxLength={80}
                  onChange={(event) => updateRow(index, { rankLabel: event.target.value })}
                />
              </div>
              <div className="form-field">
                <FormLabel htmlFor={`prize-title-${index}`} required>
                  Nama hadiah
                </FormLabel>
                <FormInput
                  id={`prize-title-${index}`}
                  value={row.title}
                  maxLength={160}
                  onChange={(event) => updateRow(index, { title: event.target.value })}
                />
              </div>
              <div className="form-field">
                <FormLabel
                  htmlFor={`prize-cash-${index}`}
                  required={!row.isCertificate}
                  optional={row.isCertificate}
                >
                  Nominal tunai (Rp)
                </FormLabel>
                <FormInput
                  id={`prize-cash-${index}`}
                  type="number"
                  min={0}
                  value={row.cashAmount}
                  onChange={(event) => updateRow(index, { cashAmount: event.target.value })}
                />
              </div>
              <div className="form-field">
                <CheckboxField
                  id={`prize-cert-${index}`}
                  checked={row.isCertificate}
                  onChange={(event) => updateRow(index, { isCertificate: event.target.checked })}
                >
                  Termasuk sertifikat
                </CheckboxField>
              </div>
              <div className="form-field">
                <FormLabel htmlFor={`prize-desc-${index}`} optional>
                  Deskripsi
                </FormLabel>
                <FormTextarea
                  id={`prize-desc-${index}`}
                  rows={2}
                  value={row.description}
                  maxLength={1000}
                  onChange={(event) => updateRow(index, { description: event.target.value })}
                />
              </div>
              <IconButton
                icon="trash"
                label={`Hapus hadiah ${index + 1}`}
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
              label="Tambah hadiah"
              onClick={() => setRows((prev) => [...prev, emptyRow()])}
            />
          </div>
        </div>
      )}
    </section>
  );
};
