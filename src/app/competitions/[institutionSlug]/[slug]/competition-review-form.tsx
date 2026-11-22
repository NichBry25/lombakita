"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, FormLabel, FormTextarea, SelectField } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { sessionFetch } from "@/lib/session/session-fetch";

// A key "<code>.<field>" holds the sentence for a refusal about one field.
const REVIEW_ERROR_COPY: Partial<Record<string, string>> = {
  forbidden: "Akun Anda bukan akun kandidat. Masuk dengan akun kandidat untuk melanjutkan.",
  "review_invalid_value.rating": "Pilih penilaian 1 sampai 5.",
  "review_invalid_value.body": "Ulasan maksimal 2000 karakter.",
  review_invalid_value: "Periksa penilaian dan ulasan Anda lalu coba lagi.",
  review_not_eligible: "Hanya peserta dengan pendaftaran terkonfirmasi yang dapat memberi ulasan.",
};

const REVIEW_SAVE_FALLBACK = "Gagal menyimpan ulasan. Coba lagi.";

const refusalCopyKey = (
  code: string | undefined,
  field: string | undefined,
): string | undefined => {
  const fieldKey = `${code}.${field}`;
  return field && REVIEW_ERROR_COPY[fieldKey] ? fieldKey : code;
};

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
          error?: { code?: string; details?: { fields?: string[] } };
        } | null;
        const copyKey = refusalCopyKey(payload?.error?.code, payload?.error?.details?.fields?.[0]);
        addToast({
          type: "error",
          message: errorMessageFor(copyKey, REVIEW_ERROR_COPY, REVIEW_SAVE_FALLBACK),
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
        <FormLabel htmlFor="review-rating" required>
          Penilaian
        </FormLabel>
        <SelectField
          id="review-rating"
          label="Penilaian"
          required
          value={String(rating)}
          onChange={(value) => setRating(Number(value))}
          options={[5, 4, 3, 2, 1].map((value) => ({
            value: String(value),
            label: `${value} bintang`,
          }))}
        />
      </div>
      <div className="form-field">
        <FormLabel htmlFor="review-body" optional>
          Ulasan
        </FormLabel>
        <FormTextarea
          id="review-body"
          rows={3}
          value={body}
          maxLength={2000}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <Button type="submit" loading={isSaving}>
        {initialReview ? "Perbarui ulasan" : "Kirim ulasan"}
      </Button>
    </form>
  );
}
