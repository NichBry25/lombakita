"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";
import { useToast } from "@/components/ui/primitives";

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
          message:
            code === SESSION_MISMATCH_CODE
              ? SESSION_MISMATCH_MESSAGE
              : `Gagal menandai dibaca (${res.status}).`,
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
