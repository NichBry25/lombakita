"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, SelectField } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

type Props = {
  competitionId: string;
  expectedUserId: string;
  initialReview: { rating: number; body: string | null } | null;
};

export function CompetitionReviewForm({ competitionId, expectedUserId, initialReview }: Props) {
  const router = useRouter();
  const { addToast } = useToast();
  const [rating, setRating] = useState(initialReview?.rating ?? 5);
  const [body, setBody] = useState(initialReview?.body ?? "");
  const [isSaving, setIsSaving] = useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/reviews/me`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rating, body }),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        addToast({
          type: "error",
          message:
            payload?.error?.code === SESSION_MISMATCH_CODE
              ? SESSION_MISMATCH_MESSAGE
              : (payload?.error?.message ?? "Gagal menyimpan ulasan. Coba lagi."),
        });
        return;
      }
      addToast({
        type: "success",
        message: initialReview ? "Ulasan diperbarui." : "Ulasan terkirim. Terima kasih!",
      });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Gagal menyimpan ulasan karena gangguan koneksi." });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form className="stack-sm" onSubmit={onSubmit}>
      <div className="form-field">
        <label className="form-label" htmlFor="review-rating">
          Penilaian
        </label>
        <SelectField
          id="review-rating"
          label="Penilaian"
          value={String(rating)}
          onChange={(value) => setRating(Number(value))}
          options={[5, 4, 3, 2, 1].map((value) => ({
            value: String(value),
            label: `${value} bintang`,
          }))}
        />
      </div>
      <div className="form-field">
        <label className="form-label" htmlFor="review-body">
          Ulasan (opsional)
        </label>
        <textarea
          id="review-body"
          className="form-input"
          rows={3}
          value={body}
          maxLength={2000}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <Button type="submit" disabled={isSaving} loading={isSaving}>
        {isSaving ? "Menyimpan..." : initialReview ? "Perbarui ulasan" : "Kirim ulasan"}
      </Button>
    </form>
  );
}
