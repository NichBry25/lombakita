"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Competition = {
  id: string;
  slug: string;
  title: string;
  status: "draft" | "published" | "archived";
  createdAt: string;
};

type FeedbackState = { type: "success" | "error"; message: string } | null;

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message ?? "Permintaan gagal diproses.";
  } catch {
    return "Permintaan gagal diproses.";
  }
};

export const InstitutionCompetitionsShell = ({ institutionSlug }: { institutionSlug: string }) => {
  const [items, setItems] = useState<Competition[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [title, setTitle] = useState("");
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(
      `/api/v1/competitions?institutionSlug=${encodeURIComponent(institutionSlug)}`,
      { cache: "no-store", credentials: "include" },
    );
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as { competitions: Competition[] };
    setItems(data.competitions);
    setIsLoading(false);
  }, [institutionSlug]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const onCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) return;
    setIsSubmitting(true);
    setFeedback(null);
    const response = await fetch("/api/v1/competitions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ institutionSlug, title: title.trim() }),
    });
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      setIsSubmitting(false);
      return;
    }
    setTitle("");
    setFeedback({ type: "success", message: "Draf kompetisi berhasil dibuat." });
    setIsSubmitting(false);
    void load();
  };

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1>Kompetisi — {institutionSlug}</h1>

      <section style={{ marginTop: 16, padding: 16, border: "1px solid #ccc" }}>
        <h2>Buat Draf Baru</h2>
        <form onSubmit={onCreate}>
          <label style={{ display: "block", marginBottom: 8 }}>
            Judul
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              minLength={3}
              maxLength={200}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Menyimpan..." : "Buat draf"}
          </button>
        </form>
        {feedback ? (
          <p
            role="status"
            style={{ color: feedback.type === "error" ? "#b00" : "#070", marginTop: 8 }}
          >
            {feedback.message}
          </p>
        ) : null}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Daftar Kompetisi</h2>
        {isLoading ? (
          <p>Memuat...</p>
        ) : items.length === 0 ? (
          <p>Belum ada kompetisi.</p>
        ) : (
          <ul>
            {items.map((c) => (
              <li key={c.id} style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                <Link href={`/institution/${institutionSlug}/competitions/${c.id}`}>{c.title}</Link>{" "}
                — <strong>{c.status}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
};
