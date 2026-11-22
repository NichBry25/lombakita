"use client";

import { useState } from "react";
import { Button, Icon } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { errorMessageFor } from "@/lib/errors/error-copy";

const OPEN_PROOF_ERROR_COPY: Partial<Record<string, string>> = {
  manual_proof_upload_unavailable:
    "Penyimpanan berkas tidak tersedia, jadi bukti transfer belum dapat dibuka. Coba lagi nanti.",
  manual_proof_not_found: "Bukti transfer tidak ditemukan. Muat ulang halaman lalu coba lagi.",
  operator_actor_is_target: "Anda tidak dapat membuka bukti transfer dari pembayaran Anda sendiri.",
  operator_actor_conflicted:
    "Anda tidak dapat mengambil tindakan atas institusi ini karena akun Anda pernah mengajukan verifikasi, diundang, atau menjadi anggota institusi tersebut.",
  operator_actor_not_found: "Akun Anda tidak ditemukan. Masuk lagi untuk melanjutkan.",
  operator_actor_not_platform_ops:
    "Akun Anda tidak lagi memiliki peran yang diperlukan untuk tindakan ini.",
  operator_actor_suspended: "Akun Anda sedang ditangguhkan oleh tim Lombakita.",
};

const OPEN_PROOF_FALLBACK = "Bukti transfer tidak dapat dibuka. Coba lagi.";

/**
 * Opens the receipt itself, through a short-lived signed link.
 *
 * THE ONLY CONTROL ON THIS SURFACE, and it reads rather than decides (DEC-0162). It is a button
 * rather than a link because the URL does not exist until it is asked for: the server mints a
 * presigned link with a two-minute life and writes the audit row naming the payer before returning
 * it, so a href rendered into the page would be a standing key to somebody's bank details.
 */
export function DisputeProofFileButton({ proofId }: { proofId: string }) {
  const { addToast } = useToast();
  const [isOpening, setIsOpening] = useState(false);

  const open = async () => {
    setIsOpening(true);
    try {
      const response = await fetch(`/api/finance-ops/payment-proofs/${proofId}/view`, {
        method: "POST",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        addToast({
          type: "error",
          message: errorMessageFor(
            payload?.error?.code,
            OPEN_PROOF_ERROR_COPY,
            OPEN_PROOF_FALLBACK,
          ),
        });
        return;
      }

      const { url } = (await response.json()) as { url: string };
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      addToast({ type: "error", message: "Gagal membuka bukti transfer karena gangguan koneksi." });
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <div className="record-actions">
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={isOpening}
        leadingIcon={<Icon name="eye" size="sm" />}
        onClick={() => void open()}
      >
        Lihat bukti transfer
      </Button>
    </div>
  );
}
