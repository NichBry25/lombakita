"use client";

import { useState } from "react";
import { Button, Icon } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";

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
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Bukti transfer tidak dapat dibuka.",
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
