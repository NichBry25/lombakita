"use client";

import { useState } from "react";
import { Button, Icon } from "@/components/ui";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";
import { useToast } from "@/components/ui/primitives";

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
        addToast({
          type: "error",
          message:
            body.error?.code === SESSION_MISMATCH_CODE
              ? SESSION_MISMATCH_MESSAGE
              : (body.error?.code ?? "Terjadi kesalahan. Coba lagi."),
        });
      } else {
        setSaved(!saved);
      }
    } catch {
      addToast({ type: "error", message: "Terjadi kesalahan. Coba lagi." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      variant={saved ? "secondary" : "outline"}
      size="lg"
      fullWidth
      leadingIcon={
        <Icon
          name="bookmark"
          size="md"
          className={saved ? "icon-bookmark-selected" : undefined}
        />
      }
      onClick={handleToggle}
      disabled={loading}
    >
      {loading ? "Memuat…" : saved ? "Disimpan" : "Simpan kompetisi"}
    </Button>
  );
}
