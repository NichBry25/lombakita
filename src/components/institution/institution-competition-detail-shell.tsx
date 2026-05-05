"use client";

import { useCallback, useEffect, useState } from "react";

type CompetitionStatus = "draft" | "published" | "archived";
type CompetitionMode = "individual" | "team" | "both";

type Competition = {
  id: string;
  institutionId: string;
  slug: string;
  title: string;
  description: string;
  status: CompetitionStatus;
  category: string | null;
  mode: CompetitionMode | null;
  registrationStartAt: string | null;
  registrationEndAt: string | null;
  eventStartAt: string | null;
  eventEndAt: string | null;
  publishedAt: string | null;
  archivedAt: string | null;
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

const toDateInputValue = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};

const fromDateInputValue = (value: string): string | null => {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const InstitutionCompetitionDetailShell = ({
  institutionSlug,
  competitionId,
}: {
  institutionSlug: string;
  competitionId: string;
}) => {
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<CompetitionMode | "">("");
  const [eventStartAt, setEventStartAt] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as { competition: Competition };
    setCompetition(data.competition);
    setTitle(data.competition.title);
    setDescription(data.competition.description ?? "");
    setMode((data.competition.mode ?? "") as CompetitionMode | "");
    setEventStartAt(toDateInputValue(data.competition.eventStartAt));
    setIsLoading(false);
  }, [competitionId]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const onSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setFeedback(null);
    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        title,
        description,
        mode: mode === "" ? null : mode,
        eventStartAt: fromDateInputValue(eventStartAt),
      }),
    });
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      setIsSubmitting(false);
      return;
    }
    setFeedback({ type: "success", message: "Perubahan tersimpan." });
    setIsSubmitting(false);
    void load();
  };

  const onTransition = async (targetStatus: CompetitionStatus) => {
    setIsSubmitting(true);
    setFeedback(null);
    const response = await fetch(
      `/api/v1/competitions/${encodeURIComponent(competitionId)}/status`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ targetStatus }),
      },
    );
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      setIsSubmitting(false);
      return;
    }
    setFeedback({ type: "success", message: `Status diubah menjadi ${targetStatus}.` });
    setIsSubmitting(false);
    void load();
  };

  const onDelete = async () => {
    if (!confirm("Hapus draf ini?")) return;
    setIsSubmitting(true);
    setFeedback(null);
    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok && response.status !== 204) {
      const message = await extractErrorMessage(response);
      setFeedback({ type: "error", message });
      setIsSubmitting(false);
      return;
    }
    window.location.href = `/institution/${encodeURIComponent(institutionSlug)}/competitions`;
  };

  if (isLoading) {
    return (
      <main style={{ padding: 24 }}>
        <p>Memuat...</p>
      </main>
    );
  }

  if (!competition) {
    return (
      <main style={{ padding: 24 }}>
        <p style={{ color: "#b00" }}>{feedback?.message ?? "Kompetisi tidak ditemukan."}</p>
      </main>
    );
  }

  const isDraft = competition.status === "draft";
  const isPublished = competition.status === "published";

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1>{competition.title}</h1>
      <p>
        Status: <strong>{competition.status}</strong>
      </p>

      {isDraft ? (
        <form onSubmit={onSave} style={{ marginTop: 16 }}>
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
          <label style={{ display: "block", marginBottom: 8 }}>
            Deskripsi
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Mode
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as CompetitionMode | "")}
              style={{ display: "block" }}
            >
              <option value="">— pilih —</option>
              <option value="individual">individual</option>
              <option value="team">team</option>
              <option value="both">both</option>
            </select>
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Tanggal mulai event
            <input
              type="date"
              value={eventStartAt}
              onChange={(e) => setEventStartAt(e.target.value)}
              style={{ display: "block" }}
            />
          </label>
          <button type="submit" disabled={isSubmitting}>
            Simpan
          </button>
        </form>
      ) : (
        <p>Field terkunci karena kompetisi tidak dalam status draft.</p>
      )}

      <section style={{ marginTop: 16, padding: 12, border: "1px solid #ccc" }}>
        <h2>Aksi Status</h2>
        {isDraft ? (
          <>
            <button onClick={() => onTransition("published")} disabled={isSubmitting} type="button">
              Publish
            </button>{" "}
            <button onClick={() => onTransition("archived")} disabled={isSubmitting} type="button">
              Arsipkan
            </button>{" "}
            <button onClick={onDelete} disabled={isSubmitting} type="button">
              Hapus draf
            </button>
          </>
        ) : null}
        {isPublished ? (
          <>
            <button onClick={() => onTransition("draft")} disabled={isSubmitting} type="button">
              Unpublish (kembali ke draft)
            </button>{" "}
            <button onClick={() => onTransition("archived")} disabled={isSubmitting} type="button">
              Arsipkan
            </button>
          </>
        ) : null}
        {competition.status === "archived" ? <p>Kompetisi sudah diarsipkan (terminal).</p> : null}
      </section>

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
