"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, FormActionBar, IconButton, PageHeader, SelectField } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";

import { COMPETITION_CATEGORY_OPTIONS } from "@/lib/competitions/categories";

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message ?? "Permintaan gagal diproses.";
  } catch {
    return "Permintaan gagal diproses.";
  }
};

export const InstitutionCompetitionCreateShell = ({
  institutionSlug,
}: {
  institutionSlug: string;
}) => {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { addToast } = useToast();
  const router = useRouter();
  const backHref = `/institution/${institutionSlug}/competitions`;

  const onSubmit = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setIsSubmitting(true);

    const body: Record<string, unknown> = {
      institutionSlug,
      title: title.trim(),
    };
    if (slug.trim().length > 0) body.slug = slug.trim();
    if (category.length > 0) body.category = category;

    const response = await fetch("/api/v1/competitions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      addToast({ type: "error", message });
      setIsSubmitting(false);
      return;
    }

    // G6 (Step 6.5b): institution-side competition pages are slug-keyed. Navigate to the edit
    // page by the competition's slug, not its internal id, or the [competitionSlug] route 404s.
    const data = (await response.json()) as { competition: { id: string; slug: string } };
    window.location.href = `/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(data.competition.slug)}/edit`;
  };

  return (
    <main className="page-shell app-page competition-form-page">
      <PageHeader
        title="Buat draf kompetisi"
        description="Mulai dengan identitas inti. Detail jadwal, format, dan publikasi diatur setelah draf dibuat."
      />

      <form onSubmit={onSubmit} className="content-section stack-md">
        <label className="form-field">
          <span className="form-label form-label-required">Judul</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            minLength={5}
            maxLength={200}
            className="form-input"
          />
          <span className="form-help">5–200 karakter.</span>
        </label>

        <label className="form-field">
          <span className="form-label">Slug (Opsional)</span>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="form-input"
          />
          <span className="form-help">
            Gunakan huruf kecil, angka, dan tanda hubung; 3–120 karakter.
          </span>
        </label>

        <div className="form-field">
          <span className="form-label" id="create-category-label">
            Kategori (Opsional)
          </span>
          <SelectField
            label="Kategori"
            id="create-category-label"
            value={category}
            placeholder="Pilih"
            options={[...COMPETITION_CATEGORY_OPTIONS]}
            onChange={setCategory}
          />
        </div>
      </form>

      <FormActionBar>
        <IconButton
          icon="arrow-left"
          label="Daftar kompetisi"
          onClick={() => router.push(backHref)}
        />
        <div className="form-action-bar-end">
          <Button type="button" onClick={() => onSubmit()} loading={isSubmitting}>
            Buat draf
          </Button>
        </div>
      </FormActionBar>
    </main>
  );
};
