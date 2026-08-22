"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, CheckboxField, IconButton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

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

export const CompetitionPrizesEditor = ({
  competitionId,
  expectedUserId,
}: {
  competitionId: string;
  expectedUserId: string;
}) => {
  const { addToast } = useToast();
  const [rows, setRows] = useState<PrizeRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

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
      setRows(
        prizes.map((prize) => ({
          rankLabel: prize.rankLabel ?? "",
          title: prize.title,
          cashAmount: prize.cashAmount ?? "",
          isCertificate: prize.isCertificate,
          description: prize.description ?? "",
        })),
      );
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

  const savePrizes = async () => {
    if (isSaving) return;
    setIsSaving(true);
    const prizes = rows
      .filter((row) => row.title.trim().length > 0)
      .map((row) => ({
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
        const body = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        addToast({
          type: "error",
          message:
            body?.error?.code === SESSION_MISMATCH_CODE
              ? SESSION_MISMATCH_MESSAGE
              : (body?.error?.message ?? "Gagal menyimpan hadiah. Coba lagi."),
        });
        return;
      }
      addToast({ type: "success", message: "Hadiah berhasil disimpan." });
      await loadPrizes();
    } catch {
      addToast({ type: "error", message: "Gagal menyimpan hadiah karena gangguan koneksi." });
    } finally {
      setIsSaving(false);
    }
  };

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
      ) : (
        <div className="stack-md">
          {rows.map((row, index) => (
            <div key={index} className="surface-card card-padding stack-sm">
              <div className="form-field">
                <label className="form-label" htmlFor={`prize-rank-${index}`}>
                  Tingkat (mis. Juara 1)
                </label>
                <input
                  id={`prize-rank-${index}`}
                  className="form-input"
                  value={row.rankLabel}
                  maxLength={80}
                  onChange={(event) => updateRow(index, { rankLabel: event.target.value })}
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor={`prize-title-${index}`}>
                  Nama hadiah
                </label>
                <input
                  id={`prize-title-${index}`}
                  className="form-input"
                  value={row.title}
                  maxLength={160}
                  onChange={(event) => updateRow(index, { title: event.target.value })}
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor={`prize-cash-${index}`}>
                  Nominal tunai (Rp)
                </label>
                <input
                  id={`prize-cash-${index}`}
                  className="form-input"
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
                <label className="form-label" htmlFor={`prize-desc-${index}`}>
                  Deskripsi
                </label>
                <textarea
                  id={`prize-desc-${index}`}
                  className="form-input"
                  rows={2}
                  value={row.description}
                  maxLength={1000}
                  onChange={(event) => updateRow(index, { description: event.target.value })}
                />
              </div>
              <IconButton
                icon="trash"
                label={`Hapus hadiah ${index + 1}`}
                variant="danger"
                size="sm"
                className="remove-row-button"
                onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
              />
            </div>
          ))}

          <div className="cluster">
            <IconButton
              type="button"
              size="sm"
              icon="plus"
              label="Tambah hadiah"
              onClick={() => setRows((prev) => [...prev, emptyRow()])}
            />
            <Button type="button" onClick={savePrizes} loading={isSaving}>
              Simpan
            </Button>
          </div>
        </div>
      )}
    </section>
  );
};
