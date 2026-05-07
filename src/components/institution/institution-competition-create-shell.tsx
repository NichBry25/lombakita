"use client";

import { useState } from "react";

const CATEGORY_OPTIONS = [
  "technology",
  "science",
  "business",
  "creative_arts",
  "social_humanities",
  "sports",
  "academic",
  "other",
] as const;

type Feedback = { type: "success" | "error"; message: string } | null;

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
  const [feedback, setFeedback] = useState<Feedback>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setFeedback(null);

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
      setFeedback({ type: "error", message });
      setIsSubmitting(false);
      return;
    }

    const data = (await response.json()) as { competition: { id: string } };
    window.location.href = `/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(data.competition.id)}/edit`;
  };

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1>Buat Draf Kompetisi — {institutionSlug}</h1>

      <form onSubmit={onSubmit} style={{ marginTop: 16 }}>
        <label style={{ display: "block", marginBottom: 8 }}>
          Judul (5–200 karakter)
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            minLength={5}
            maxLength={200}
            style={{ display: "block", width: "100%" }}
          />
        </label>

        <label style={{ display: "block", marginBottom: 8 }}>
          Slug (opsional, ^[a-z0-9-]+$, 3–120 karakter)
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            style={{ display: "block", width: "100%" }}
          />
        </label>

        <label style={{ display: "block", marginBottom: 8 }}>
          Kategori (opsional)
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={{ display: "block" }}
          >
            <option value="">— pilih —</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Menyimpan..." : "Buat draf"}
        </button>
      </form>

      {feedback ? (
        <p
          role="status"
          style={{ color: feedback.type === "error" ? "#b00" : "#070", marginTop: 16 }}
        >
          {feedback.message}
        </p>
      ) : null}
    </main>
  );
};
