"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  ButtonLink,
  EmptyState,
  IconButtonLink,
  PageHeader,
  Skeleton,
  usePageTransition,
} from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
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

const formatFailures = (failures: PublishValidationFailure[] | undefined): string => {
  if (!failures || failures.length === 0) return "";
  return failures
    .map((f) => `${getCompetitionFieldLabel(f.field)} — ${capitalizeFirst(f.message)}`)
    .join("; ");
};

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
  const { addToast } = useToast();
  const { begin: beginPageTransition } = usePageTransition();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Several lifecycle actions live side by side; the key records which one is running so only
  // that button spins while the rest stay locked.
  const [pendingAction, setPendingAction] = useState<ActionKind | "delete" | null>(null);
  const isSubmitting = pendingAction !== null;

  const load = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) {
      const { message } = await extractError(response);
      addToast({ type: "error", message });
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as { competition: Competition };
    setCompetition(data.competition);
    setIsLoading(false);
  }, [competitionId, addToast]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  useEffect(() => {
    if (competition?.status === "archived") {
      addToast({ type: "info", message: "Kompetisi sudah diarsipkan (terminal)." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competition?.status]);

  const onAction = async (action: ActionKind) => {
    setPendingAction(action);
    const url = `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionId)}/${action}`;
    const response = await fetch(url, { method: "POST", credentials: "include" });
    if (!response.ok) {
      const { message, failures } = await extractError(response);
      const failureText = formatFailures(failures);
      addToast({
        type: "error",
        message: failureText ? `${message} (${failureText})` : message,
      });
      setPendingAction(null);
      return;
    }
    addToast({ type: "success", message: actionLabel[action] });
    setPendingAction(null);
    void load();
  };

  const runDelete = async () => {
    setPendingAction("delete");
    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok && response.status !== 204) {
      const { message } = await extractError(response);
      addToast({ type: "error", message });
      setPendingAction(null);
      return;
    }
    // Deleting the draft leaves this page for the competition list.
    beginPageTransition("Menghapus draf…");
    window.location.href = `/institution/${encodeURIComponent(institutionSlug)}/competitions`;
  };

  const confirmDelete = () => {
    openModal({
      title: "Hapus draf ini?",
      closeable: true,
      body: "Draf kompetisi ini akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.",
      actions: [
        { label: "Batal", variant: "secondary", autoClose: true, onClick: () => {} },
        {
          label: "Hapus draf",
          variant: "danger",
          autoClose: true,
          onClick: () => {
            void runDelete();
          },
        },
      ],
    });
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
          description="Data kompetisi tidak dapat dimuat."
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
          <IconButtonLink
            href={`/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(
              competition.slug,
            )}/edit`}
            icon="edit"
            label="Edit kompetisi"
            variant="outline"
            size="sm"
          />
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
            >
              Terbitkan
            </Button>
            <Button
              variant="outline"
              onClick={() => onAction("archive")}
              loading={pendingAction === "archive"}
              disabled={isSubmitting}
            >
              Arsipkan
            </Button>
            <Button
              variant="danger"
              onClick={confirmDelete}
              loading={pendingAction === "delete"}
              disabled={isSubmitting}
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
                      label: "Tarik publikasi",
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
            >
              Tarik publikasi
            </Button>
            <Button
              variant="outline"
              onClick={() => onAction("archive")}
              loading={pendingAction === "archive"}
              disabled={isSubmitting}
            >
              Arsipkan
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  );
};
