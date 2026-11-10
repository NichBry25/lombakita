"use client";

import { useState } from "react";
import { IconButton } from "@/components/ui";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { sessionFetch } from "@/lib/session/session-fetch";
import { useToast } from "@/components/ui/primitives";

const SAVE_ERROR_COPY: Partial<Record<string, string>> = {
  competition_not_found: "Kompetisi tidak ditemukan.",
  competition_not_saveable: "Kompetisi ini sudah tidak tersedia.",
  forbidden: "Akun Anda bukan akun kandidat. Masuk dengan akun kandidat untuk melanjutkan.",
};

const SAVE_FALLBACK = "Gagal menyimpan kompetisi. Silakan coba lagi.";
const UNSAVE_FALLBACK = "Gagal menghapus kompetisi dari daftar tersimpan. Coba lagi.";
const SAVE_SUCCESS = "Kompetisi disimpan.";
const UNSAVE_SUCCESS = "Kompetisi dihapus dari daftar tersimpan.";

type Props = {
  competitionId: string;
  initialSaved: boolean;
  expectedUserId: string;
};

export function SaveButton({ competitionId, initialSaved, expectedUserId }: Props) {
  const { addToast } = useToast();
  const [saved, setSaved] = useState(initialSaved);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    setLoading(true);
    const method = saved ? "DELETE" : "POST";
    try {
      const res = await sessionFetch(expectedUserId, `/api/v1/competitions/${competitionId}/save`, {
        method,
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: { code?: string } };
        const fallback = saved ? UNSAVE_FALLBACK : SAVE_FALLBACK;
        addToast({
          type: "error",
          message: errorMessageFor(body.error?.code, SAVE_ERROR_COPY, fallback),
        });
      } else {
        setSaved(!saved);
        addToast({ type: "success", message: saved ? UNSAVE_SUCCESS : SAVE_SUCCESS });
      }
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan. Coba lagi." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <IconButton
      type="button"
      variant="outline"
      size="lg"
      className="detail-save-action"
      icon="bookmark"
      label="Simpan kompetisi"
      aria-pressed={saved}
      data-saved={saved ? "true" : "false"}
      onClick={handleToggle}
      loading={loading}
    />
  );
}
