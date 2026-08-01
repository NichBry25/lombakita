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
import { resolveResultAnnouncement } from "@/lib/competitions/competition-phase";
import { useWithdrawalAvailability } from "@/components/competitions/use-withdrawal-availability";
import { capitalizeFirst, capitalizeWord } from "@/lib/text/capitalize";
import {
  getCompetitionCancellationReasonLabel,
  getCompetitionParticipationStateLabel,
  type CompetitionParticipationState,
} from "@/lib/competitions/competition-participation";

type CompetitionStatus = "draft" | "published";
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
  resultAnnouncementAt: string | null;
  minimumParticipantEntries: number | null;
  participantConfirmationAt: string | null;
  participationConfirmedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  publishedAt: string | null;
};

type ParticipationSummary = {
  minimumParticipantEntries: number | null;
  participantConfirmationAt: string | null;
  participationConfirmedAt: string | null;
  participantEntryCount: number;
  state: CompetitionParticipationState;
  canCancel: boolean;
  canConfirmProceed: boolean;
};

type PublishValidationFailure = {
  field: string;
  code: "missing" | "out_of_order" | "not_in_future";
  message: string;
};

const formatFailures = (failures: PublishValidationFailure[] | undefined): string => {
  if (!failures || failures.length === 0) return "";
  return failures
    .map((f) => `${getCompetitionFieldLabel(f.field)}: ${capitalizeFirst(f.message)}`)
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

type ActionKind = "publish" | "unpublish";
type ParticipationDecision = "cancel" | "proceed";

const actionLabel: Record<ActionKind, string> = {
  publish: "Status diterbitkan (published).",
  unpublish: "Kompetisi ditarik ke draft dan semua pendaftaran dibatalkan.",
};

export const InstitutionCompetitionDetailShell = ({
  institutionSlug,
  competitionId,
  canDecideParticipation,
}: {
  institutionSlug: string;
  competitionId: string;
  canDecideParticipation: boolean;
}) => {
  const { openModal } = useModal();
  const { addToast } = useToast();
  const { begin: beginPageTransition } = usePageTransition();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [hasActiveRegistrations, setHasActiveRegistrations] = useState(false);
  const [participation, setParticipation] = useState<ParticipationSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Several lifecycle actions live side by side; the key records which one is running so only
  // that button spins while the rest stay locked.
  const [pendingAction, setPendingAction] = useState<
    ActionKind | ParticipationDecision | "delete" | null
  >(null);
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
    const data = (await response.json()) as {
      competition: Competition;
      hasActiveRegistrations: boolean;
      participation: ParticipationSummary;
    };
    setCompetition(data.competition);
    setHasActiveRegistrations(data.hasActiveRegistrations);
    setParticipation(data.participation);
    setIsLoading(false);
  }, [competitionId, addToast]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  // Called before the loading and not-found returns below so the hook order stays stable. The
  // competition is absent on the first pass, which reads as "not started" and is never shown.
  const canWithdraw = useWithdrawalAvailability({
    eventStartAt: competition?.eventStartAt ?? null,
    participantConfirmationAt: competition?.participantConfirmationAt ?? null,
    hasActiveRegistrations,
  });

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

  const onParticipationDecision = async (decision: ParticipationDecision) => {
    setPendingAction(decision);
    const url = `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionId)}/participation-decision`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ decision }),
    });
    if (!response.ok) {
      const { message } = await extractError(response);
      addToast({ type: "error", message });
      setPendingAction(null);
      return;
    }
    addToast({
      type: "success",
      message:
        decision === "cancel" ? "Kompetisi dibatalkan." : "Kompetisi dikonfirmasi tetap berjalan.",
    });
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
          label: "Hapus",
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
  const isCancelled = competition.cancelledAt !== null;
  // When no date was entered the public page falls back to one derived from the event end; show
  // the organizer the same value, marked as the estimate it is.
  const resolvedAnnouncement = resolveResultAnnouncement(competition);
  const announcementIsDerived = resolvedAnnouncement.source === "derived";

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
            data-status={isCancelled ? "cancelled" : isPublished ? "open" : "closing"}
          >
            {isCancelled ? "Dibatalkan" : capitalizeWord(competition.status)}
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
            <dt>Pengumuman hasil</dt>
            <dd className="data-text">
              {formatDate(resolvedAnnouncement.at?.toISOString() ?? null)}
              {announcementIsDerived ? " (perkiraan)" : ""}
            </dd>
          </div>
          <div>
            <dt>Diterbitkan</dt>
            <dd className="data-text">{formatDate(competition.publishedAt)}</dd>
          </div>
          <div>
            <dt>Minimum peserta</dt>
            <dd className="data-text">
              {competition.minimumParticipantEntries?.toLocaleString("id-ID") ?? "—"}
            </dd>
          </div>
          <div>
            <dt>Konfirmasi peserta</dt>
            <dd className="data-text">{formatDate(competition.participantConfirmationAt)}</dd>
          </div>
        </dl>
      </section>

      {participation &&
      competition.minimumParticipantEntries !== null &&
      competition.minimumParticipantEntries >= 1 ? (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Minimum peserta</p>
              <h2>{getCompetitionParticipationStateLabel(participation.state)}</h2>
            </div>
          </div>
          <p className="data-text">
            {participation.participantEntryCount.toLocaleString("id-ID")} dari{" "}
            {competition.minimumParticipantEntries.toLocaleString("id-ID")} pendaftaran
          </p>
          <p className="form-help">
            Satu peserta individu atau satu tim dihitung sebagai satu pendaftaran.
          </p>
          {isCancelled ? (
            <p className="feedback" data-tone="error">
              {getCompetitionCancellationReasonLabel(competition.cancellationReason) ??
                "Kompetisi dibatalkan."}
            </p>
          ) : null}
          {canDecideParticipation &&
          (participation.canCancel || participation.canConfirmProceed) ? (
            <div className="record-actions">
              {participation.canConfirmProceed ? (
                <Button
                  variant="secondary"
                  loading={pendingAction === "proceed"}
                  disabled={isSubmitting}
                  onClick={() =>
                    openModal({
                      title: "Tetap jalankan kompetisi?",
                      closeable: true,
                      body: "Kompetisi akan dikonfirmasi tetap berjalan meskipun minimum peserta belum tercapai. Setelah dikonfirmasi, kompetisi tidak dapat dibatalkan karena kekurangan peserta.",
                      actions: [
                        {
                          label: "Kembali",
                          variant: "secondary",
                          autoClose: true,
                          onClick: () => {},
                        },
                        {
                          label: "Tetap jalankan",
                          variant: "primary",
                          autoClose: true,
                          onClick: () => {
                            void onParticipationDecision("proceed");
                          },
                        },
                      ],
                    })
                  }
                >
                  Tetap jalankan
                </Button>
              ) : null}
              {participation.canCancel ? (
                <Button
                  variant="danger"
                  loading={pendingAction === "cancel"}
                  disabled={isSubmitting}
                  onClick={() =>
                    openModal({
                      title: "Batalkan kompetisi?",
                      closeable: true,
                      body: "Minimum peserta belum tercapai. Kompetisi akan tetap terlihat dengan status Dibatalkan, semua pendaftaran aktif dibatalkan, dan peserta diberi tahu. Tindakan ini tidak dapat dibatalkan.",
                      actions: [
                        {
                          label: "Kembali",
                          variant: "secondary",
                          autoClose: true,
                          onClick: () => {},
                        },
                        {
                          label: "Batalkan",
                          variant: "danger",
                          autoClose: true,
                          onClick: () => {
                            void onParticipationDecision("cancel");
                          },
                        },
                      ],
                    })
                  }
                >
                  Batalkan
                </Button>
              ) : null}
            </div>
          ) : null}
          {!canDecideParticipation && participation.state === "decision_due" ? (
            <p className="form-help">
              Hanya pemilik institusi yang dapat memilih untuk tetap menjalankan atau membatalkan
              kompetisi.
            </p>
          ) : null}
        </section>
      ) : null}

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
              variant="danger"
              onClick={confirmDelete}
              loading={pendingAction === "delete"}
              disabled={isSubmitting}
            >
              Hapus
            </Button>
          </div>
        ) : null}
        {isPublished && !isCancelled ? (
          <div className="stack-sm">
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
                        label: "Tarik",
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
                disabled={isSubmitting || !canWithdraw}
                aria-describedby={canWithdraw ? undefined : "unpublish-blocked-reason"}
              >
                Tarik
              </Button>
            </div>
            {/* A disabled action has to say why it is disabled, and what to do instead. The server
                refuses this call on the same condition, so the two never disagree. */}
            {canWithdraw ? null : (
              <p className="form-field-aside" id="unpublish-blocked-reason">
                {participation?.participantConfirmationAt &&
                new Date() >= new Date(participation.participantConfirmationAt)
                  ? "Waktu konfirmasi peserta telah tiba. Kompetisi tidak dapat ditarik lagi; gunakan keputusan minimum peserta yang tersedia."
                  : "Kompetisi sudah dimulai dan pesertanya sudah terdaftar. Menarik publikasi akan membatalkan pendaftaran mereka semua, jadi tombol ini terkunci. Untuk memperbaiki informasi yang keliru, ubah lewat halaman edit. Semua peserta akan diberi tahu."}
              </p>
            )}
          </div>
        ) : null}
      </section>
    </main>
  );
};
