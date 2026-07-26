"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, IconButton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

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

export const CompetitionRoundsEditor = ({
  competitionId,
  expectedUserId,
}: {
  competitionId: string;
  expectedUserId: string;
}) => {
  const { addToast } = useToast();
  const [rows, setRows] = useState<RoundRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

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
      setRows(
        rounds.map((round) => ({
          title: round.title,
          platformLabel: round.platformLabel ?? "",
          startsAt: toLocalInputValue(round.startsAt),
          endsAt: toLocalInputValue(round.endsAt),
          description: round.description ?? "",
        })),
      );
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

  const saveRounds = async () => {
    if (isSaving) return;
    setIsSaving(true);
    const rounds = rows
      .filter((row) => row.title.trim().length > 0)
      .map((row) => ({
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
        const body = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        addToast({
          type: "error",
          message:
            body?.error?.code === SESSION_MISMATCH_CODE
              ? SESSION_MISMATCH_MESSAGE
              : (body?.error?.message ?? "Gagal menyimpan tahapan. Coba lagi."),
        });
        return;
      }
      addToast({ type: "success", message: "Tahapan berhasil disimpan." });
      await loadRounds();
    } catch {
      addToast({ type: "error", message: "Gagal menyimpan tahapan karena gangguan koneksi." });
    } finally {
      setIsSaving(false);
    }
  };

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
      ) : (
        <div className="stack-md">
          {rows.map((row, index) => (
            <div key={index} className="surface-card card-padding stack-sm">
              <div className="form-field">
                <label className="form-label" htmlFor={`round-title-${index}`}>
                  Nama tahapan
                </label>
                <input
                  id={`round-title-${index}`}
                  className="form-input"
                  value={row.title}
                  maxLength={160}
                  onChange={(event) => updateRow(index, { title: event.target.value })}
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor={`round-platform-${index}`}>
                  Format (mis. Online / Offline)
                </label>
                <input
                  id={`round-platform-${index}`}
                  className="form-input"
                  value={row.platformLabel}
                  maxLength={80}
                  onChange={(event) => updateRow(index, { platformLabel: event.target.value })}
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor={`round-start-${index}`}>
                  Mulai
                </label>
                <input
                  id={`round-start-${index}`}
                  className="form-input"
                  type="datetime-local"
                  value={row.startsAt}
                  onChange={(event) => updateRow(index, { startsAt: event.target.value })}
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor={`round-end-${index}`}>
                  Selesai
                </label>
                <input
                  id={`round-end-${index}`}
                  className="form-input"
                  type="datetime-local"
                  value={row.endsAt}
                  onChange={(event) => updateRow(index, { endsAt: event.target.value })}
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor={`round-desc-${index}`}>
                  Deskripsi
                </label>
                <textarea
                  id={`round-desc-${index}`}
                  className="form-input"
                  rows={3}
                  value={row.description}
                  maxLength={2000}
                  onChange={(event) => updateRow(index, { description: event.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="danger"
                size="sm"
                className="remove-row-button"
                onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
              >
                Hapus
              </Button>
            </div>
          ))}

          <div className="cluster">
            <IconButton
              type="button"
              size="sm"
              icon="plus"
              label="Tambah tahapan"
              onClick={() => setRows((prev) => [...prev, emptyRow()])}
            />
            <Button type="button" onClick={saveRounds} loading={isSaving}>
              Simpan
            </Button>
          </div>
        </div>
      )}
    </section>
  );
};
