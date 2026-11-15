"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconButton } from "@/components/ui";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
import { useToast } from "@/components/ui/primitives";

const DELETE_NOTIFICATION_ERROR_COPY: Partial<Record<string, string>> = {
  notification_not_found: "Notifikasi ini sudah tidak ada. Muat ulang halaman.",
};

const DELETE_NOTIFICATION_FALLBACK = "Gagal menghapus notifikasi. Coba lagi.";

export function DeleteNotificationButton({
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
      const res = await sessionFetch(expectedUserId, `/api/v1/me/notifications/${notificationId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const code = await readErrorCode(res);
        addToast({
          type: "error",
          message: errorMessageFor(
            code,
            DELETE_NOTIFICATION_ERROR_COPY,
            DELETE_NOTIFICATION_FALLBACK,
          ),
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
    <IconButton
      icon="trash"
      label="Hapus notifikasi"
      variant="outline"
      onClick={onClick}
      loading={pending}
    />
  );
}
