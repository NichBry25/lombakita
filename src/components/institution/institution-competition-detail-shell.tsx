"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  ButtonLink,
  EmptyState,
  PageHeader,
  Skeleton,
  usePageTransition,
} from "@/components/ui";
import { useModal } from "@/components/ui/primitives";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionFieldLabel } from "@/lib/competitions/fields";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";
import { capitalizeFirst, capitalizeWord } from "@/lib/text/capitalize";

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
  unpublish: "Kompetisi ditarik ke draft dan semua pendaftaran dibatalkan.",
  archive: "Kompetisi diarsipkan.",
};

export const InstitutionCompetitionDetailShell = ({
  institutionSlug,
  competitionId,
}: {
  institutionSlug: string;
  competitionId: string;
}) => {
  const { openModal } = useModal();
  const { begin: beginPageTransition } = usePageTransition();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Several lifecycle actions live side by side; the key records which one is running so only
  // that button spins while the rest stay locked.
  const [pendingAction, setPendingAction] = useState<ActionKind | "delete" | null>(null);
  const isSubmitting = pendingAction !== null;
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
    setPendingAction(action);
    setFeedback(null);
    const url = `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionId)}/${action}`;
    const response = await fetch(url, { method: "POST", credentials: "include" });
    if (!response.ok) {
      const { message, failures } = await extractError(response);
      setFeedback({ type: "error", message, failures });
      setPendingAction(null);
      return;
    }
    setFeedback({ type: "success", message: actionLabel[action] });
    setPendingAction(null);
    void load();
  };

  const onDelete = async () => {
    if (!confirm("Hapus draf ini?")) return;
    setPendingAction("delete");
    setFeedback(null);
    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok && response.status !== 204) {
      const { message } = await extractError(response);
      setFeedback({ type: "error", message });
      setPendingAction(null);
      return;
    }
    // Deleting the draft leaves this page for the competition list.
    beginPageTransition("Menghapus draf…");
    window.location.href = `/institution/${encodeURIComponent(institutionSlug)}/competitions`;
  };

  if (isLoading) {
    return (
      <main className="page-shell app-page competition-management-page">
        <div className="stack-md" aria-label="Memuat kompetisi">
          <Skeleton variant="title" />
          <Skeleton variant="media" />
          <Skeleton variant="media" />
        </div>
      </main>
    );
  }

  if (!competition) {
    return (
      <main className="page-shell app-page competition-management-page">
        <EmptyState
          icon="trophy"
          title="Kompetisi tidak ditemukan."
          description={feedback?.message ?? "Data kompetisi tidak dapat dimuat."}
          action={
            <ButtonLink href={`/institution/${institutionSlug}/competitions`} variant="outline">
              Kembali ke daftar
            </ButtonLink>
          }
        />
      </main>
    );
  }

  const isDraft = competition.status === "draft";
  const isPublished = competition.status === "published";
  const isArchived = competition.status === "archived";

  return (
    <main className="page-shell app-page competition-management-page">
      <PageHeader
        eyebrow="Konsol kompetisi"
        title={competition.title}
        description={`/${competition.slug}`}
        backHref={`/institution/${institutionSlug}/competitions`}
        backLabel="Kompetisi"
        actions={
          <span
            className="status-badge"
            data-status={isPublished ? "open" : isArchived ? "closed" : "closing"}
          >
            {capitalizeWord(competition.status)}
          </span>
        }
      />

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Ringkasan konfigurasi</p>
            <h2>Informasi kompetisi</h2>
          </div>
          <ButtonLink
            href={`/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(
              competition.slug,
            )}/edit`}
            variant="outline"
            size="sm"
          >
            Edit
          </ButtonLink>
        </div>
        <dl className="management-detail-grid">
          <div>
            <dt>Mode</dt>
            <dd className="data-text">
              {competition.mode ? getCompetitionModeLabel(competition.mode) : "—"}
            </dd>
          </div>
          <div>
            <dt>Kategori</dt>
            <dd className="data-text">
              {competition.category ? getCompetitionCategoryLabel(competition.category) : "—"}
            </dd>
          </div>
          <div>
            <dt>Pendaftaran mulai</dt>
            <dd className="data-text">{formatDate(competition.registrationStartAt)}</dd>
          </div>
          <div>
            <dt>Pendaftaran berakhir</dt>
            <dd className="data-text">{formatDate(competition.registrationEndAt)}</dd>
          </div>
          <div>
            <dt>Acara mulai</dt>
            <dd className="data-text">{formatDate(competition.eventStartAt)}</dd>
          </div>
          <div>
            <dt>Acara berakhir</dt>
            <dd className="data-text">{formatDate(competition.eventEndAt)}</dd>
          </div>
          <div>
            <dt>Diterbitkan</dt>
            <dd className="data-text">{formatDate(competition.publishedAt)}</dd>
          </div>
          <div>
            <dt>Diarsipkan</dt>
            <dd className="data-text">{formatDate(competition.archivedAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="content-section lifecycle-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Siklus publikasi</p>
            <h2>Aksi status</h2>
          </div>
        </div>
        {isDraft ? (
          <div className="record-actions">
            <Button
              onClick={() => onAction("publish")}
              loading={pendingAction === "publish"}
              disabled={isSubmitting}
              type="button"
            >
              Publish
            </Button>
            <Button
              variant="outline"
              onClick={() => onAction("archive")}
              loading={pendingAction === "archive"}
              disabled={isSubmitting}
              type="button"
            >
              Arsipkan
            </Button>
            <Button
              variant="danger"
              onClick={onDelete}
              loading={pendingAction === "delete"}
              disabled={isSubmitting}
              type="button"
            >
              Hapus draf
            </Button>
          </div>
        ) : null}
        {isPublished ? (
          <div className="record-actions">
            <Button
              variant="danger"
              onClick={() =>
                openModal({
                  title: "Tarik publikasi kompetisi?",
                  closeable: true,
                  body: "Menarik publikasi akan membatalkan SEMUA pendaftaran peserta untuk kompetisi ini. Tindakan ini tidak dapat dibatalkan.",
                  actions: [
                    { label: "Batal", variant: "secondary", autoClose: true, onClick: () => {} },
                    {
                      label: "Tarik publikasi & batalkan pendaftaran",
                      variant: "danger",
                      autoClose: true,
                      onClick: () => {
                        void onAction("unpublish");
                      },
                    },
                  ],
                })
              }
              loading={pendingAction === "unpublish"}
              disabled={isSubmitting}
              type="button"
            >
              Unpublish (batalkan semua pendaftaran)
            </Button>
            <Button
              variant="outline"
              onClick={() => onAction("archive")}
              loading={pendingAction === "archive"}
              disabled={isSubmitting}
              type="button"
            >
              Arsipkan
            </Button>
          </div>
        ) : null}
        {isArchived ? (
          <p className="feedback" data-tone="info">
            Kompetisi sudah diarsipkan (terminal).
          </p>
        ) : null}
      </section>

      {feedback ? (
        <div role="status" className="feedback" data-tone={feedback.type}>
          <p>{feedback.message}</p>
          {feedback.type === "error" && feedback.failures && feedback.failures.length > 0 ? (
            <ul>
              {feedback.failures.map((f) => (
                <li key={`${f.field}-${f.code}`}>
                  <strong>{getCompetitionFieldLabel(f.field)}</strong> —{" "}
                  {capitalizeFirst(f.message)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </main>
  );
};
