"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
import { useToast } from "@/components/ui/primitives";

const MARK_READ_ERROR_COPY: Partial<Record<string, string>> = {
  notification_not_found: "Notifikasi ini sudah tidak ada. Muat ulang halaman.",
};

const MARK_READ_FALLBACK = "Gagal menandai notifikasi sebagai dibaca. Coba lagi.";

export function MarkReadButton({
  notificationId,
  expectedUserId,
}: {
  notificationId: string;
  expectedUserId: string;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const [pending, setPending] = useState(false);

  const onClick = async () => {
    setPending(true);
    try {
      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/me/notifications/${notificationId}/read`,
        { method: "PATCH" },
      );
      if (!res.ok) {
        const code = await readErrorCode(res);
        addToast({
          type: "error",
          message: errorMessageFor(code, MARK_READ_ERROR_COPY, MARK_READ_FALLBACK),
        });
        setPending(false);
        return;
      }
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan jaringan. Coba lagi." });
      setPending(false);
    }
  };

  return (
    <Button type="button" onClick={onClick} loading={pending} variant="outline" size="sm">
      Tandai dibaca
    </Button>
  );
}
