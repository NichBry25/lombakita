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

type PublishValidationFailure = {
  field: string;
  code: "missing" | "out_of_order" | "not_in_future";
  message: string;
};

type Feedback =
  | { type: "success"; message: string }
  | { type: "error"; message: string; failures?: PublishValidationFailure[] }
  | null;

const extractError = async (
  response: Response,
): Promise<{ message: string; failures?: PublishValidationFailure[] }> => {
  try {
    const payload = (await response.json()) as {
      error?: { message?: string; details?: { failures?: PublishValidationFailure[] } };
    };
    return {
      message: payload.error?.message ?? "Permintaan gagal diproses.",
      failures: payload.error?.details?.failures,
    };
  } catch {
    return { message: "Permintaan gagal diproses." };
  }
};

const formatDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 16).replace("T", " ");
};

type ActionKind = "publish" | "unpublish" | "archive";

const actionLabel: Record<ActionKind, string> = {
  publish: "Status diterbitkan (published).",
  unpublish: "Status dikembalikan ke draft.",
  archive: "Kompetisi diarsipkan.",
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
  const [feedback, setFeedback] = useState<Feedback>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) {
      const { message } = await extractError(response);
      setFeedback({ type: "error", message });
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as { competition: Competition };
    setCompetition(data.competition);
    setIsLoading(false);
  }, [competitionId]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const onAction = async (action: ActionKind) => {
    setIsSubmitting(true);
    setFeedback(null);
    const url = `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionId)}/${action}`;
    const response = await fetch(url, { method: "POST", credentials: "include" });
    if (!response.ok) {
      const { message, failures } = await extractError(response);
      setFeedback({ type: "error", message, failures });
      setIsSubmitting(false);
      return;
    }
    setFeedback({ type: "success", message: actionLabel[action] });
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
      const { message } = await extractError(response);
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
  const isArchived = competition.status === "archived";

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1>{competition.title}</h1>
      <p>
        Status: <strong>{competition.status}</strong> · Slug: <code>{competition.slug}</code>
      </p>

      <section style={{ marginTop: 16, padding: 12, border: "1px solid #ccc" }}>
        <h2>Ringkasan</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          <li>
            Mode: <code>{competition.mode ?? "—"}</code>
          </li>
          <li>
            Kategori: <code>{competition.category ?? "—"}</code>
          </li>
          <li>Pendaftaran mulai: {formatDate(competition.registrationStartAt)}</li>
          <li>Pendaftaran berakhir: {formatDate(competition.registrationEndAt)}</li>
          <li>Acara mulai: {formatDate(competition.eventStartAt)}</li>
          <li>Acara berakhir: {formatDate(competition.eventEndAt)}</li>
          <li>Diterbitkan pada: {formatDate(competition.publishedAt)}</li>
          <li>Diarsipkan pada: {formatDate(competition.archivedAt)}</li>
        </ul>
        <p style={{ marginTop: 8 }}>
          <a
            href={`/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(
              competition.slug,
            )}/edit`}
          >
            Edit field draf →
          </a>
        </p>
      </section>

      <section style={{ marginTop: 16, padding: 12, border: "1px solid #ccc" }}>
        <h2>Aksi Status</h2>
        {isDraft ? (
          <>
            <button onClick={() => onAction("publish")} disabled={isSubmitting} type="button">
              Publish
            </button>{" "}
            <button onClick={() => onAction("archive")} disabled={isSubmitting} type="button">
              Arsipkan
            </button>{" "}
            <button onClick={onDelete} disabled={isSubmitting} type="button">
              Hapus draf
            </button>
          </>
        ) : null}
        {isPublished ? (
          <>
            <button onClick={() => onAction("unpublish")} disabled={isSubmitting} type="button">
              Unpublish (kembali ke draft)
            </button>{" "}
            <button onClick={() => onAction("archive")} disabled={isSubmitting} type="button">
              Arsipkan
            </button>
          </>
        ) : null}
        {isArchived ? <p>Kompetisi sudah diarsipkan (terminal).</p> : null}
      </section>

      {feedback ? (
        <div
          role="status"
          style={{
            color: feedback.type === "error" ? "#b00" : "#070",
            marginTop: 16,
            padding: 8,
            border: `1px solid ${feedback.type === "error" ? "#b00" : "#070"}`,
          }}
        >
          <p style={{ margin: 0 }}>{feedback.message}</p>
          {feedback.type === "error" && feedback.failures && feedback.failures.length > 0 ? (
            <ul style={{ marginTop: 8, marginBottom: 0 }}>
              {feedback.failures.map((f) => (
                <li key={`${f.field}-${f.code}`}>
                  <strong>{f.field}</strong> — {f.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <p style={{ marginTop: 16 }}>
        <a href={`/institution/${encodeURIComponent(institutionSlug)}/competitions`}>
          ← Kembali ke daftar kompetisi
        </a>
      </p>
    </main>
  );
};
