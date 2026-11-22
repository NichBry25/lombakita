"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  ButtonLink,
  EmptyState,
  Icon,
  IconButtonLink,
  PageHeader,
  Skeleton,
  usePageTransition,
} from "@/components/ui";
import { useModal, useToast, type ModalOutcome } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionFieldLabel } from "@/lib/competitions/fields";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";
import {
  getCompetitionHeaderPillTone,
  getCompetitionStatusLabel,
} from "@/lib/competitions/status-labels";
import { resolveResultAnnouncement } from "@/lib/competitions/competition-phase";
import { useWithdrawalAvailability } from "@/components/competitions/use-withdrawal-availability";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { resolveSessionMismatchMessage, sessionFetch } from "@/lib/session/session-fetch";
import { capitalizeFirst } from "@/lib/text/capitalize";
import {
  getPublishBlockerReason,
  resolvePublishReasonHref,
  resolvePublishRefusalToastText,
} from "@/components/institution/competition-publish-messages";
import type { CompetitionPublishReadiness } from "@/server/competitions/competition-publish-readiness";
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

type RefusalAction = "load" | "unpublish" | "decision" | "delete";

const INVALID_PAYLOAD_MESSAGE =
  "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.";

const REFUSAL_COPY: Record<RefusalAction, Partial<Record<string, string>>> = {
  load: {
    competition_not_found: "Kompetisi tidak ditemukan.",
    forbidden: "Anda tidak memiliki akses ke kompetisi institusi ini.",
  },
  unpublish: {
    competition_not_found: "Kompetisi tidak ditemukan.",
    forbidden: "Hanya pemilik institusi yang dapat menarik kompetisi.",
    competition_invalid_transition:
      "Status kompetisi sudah berubah. Muat ulang halaman lalu coba lagi.",
    competition_already_cancelled: "Kompetisi ini sudah dibatalkan.",
    competition_unpublish_blocked_after_participation_confirmation:
      "Kompetisi tidak dapat ditarik setelah tanggal konfirmasi peserta.",
    competition_unpublish_blocked_payment_in_flight:
      "Kompetisi tidak dapat ditarik selama masih ada bukti transfer yang menunggu verifikasi atau sudah diverifikasi. Verifikasi atau tolak dulu setiap bukti yang menunggu. Kompetisi dengan transfer yang sudah diverifikasi tidak dapat ditarik.",
    competition_unpublish_blocked_after_start:
      "Kompetisi yang sudah dimulai dan masih memiliki peserta tidak dapat ditarik. Ubah data kompetisi sebagai gantinya.",
  },
  decision: {
    competition_not_found: "Kompetisi tidak ditemukan.",
    forbidden: "Hanya pemilik institusi yang dapat memutuskan kelanjutan kompetisi.",
    competition_already_cancelled: "Kompetisi ini sudah dibatalkan.",
    competition_invalid_payload: INVALID_PAYLOAD_MESSAGE,
    competition_participation_decision_unavailable:
      "Keputusan kelanjutan belum tersedia atau sudah diambil. Muat ulang halaman lalu coba lagi.",
    competition_participation_not_configured:
      "Kompetisi ini tidak memiliki syarat minimum peserta, jadi tidak perlu keputusan kelanjutan.",
  },
  delete: {
    competition_not_found: "Kompetisi tidak ditemukan.",
    forbidden: "Anda tidak memiliki akses ke kompetisi institusi ini.",
    competition_delete_not_allowed: "Hanya kompetisi berstatus draf yang dapat dihapus.",
  },
};

const REFUSAL_FALLBACK: Record<RefusalAction, string> = {
  load: "Data kompetisi gagal dimuat. Muat ulang halaman lalu coba lagi.",
  unpublish: "Kompetisi gagal ditarik. Coba lagi atau hubungi dukungan Lombakita.",
  decision: "Keputusan gagal disimpan. Coba lagi.",
  delete: "Draf gagal dihapus. Coba lagi.",
};

const extractError = async (
  response: Response,
): Promise<{ code?: string; failures?: PublishValidationFailure[] }> => {
  try {
    const payload = (await response.json()) as {
      error?: {
        code?: string;
        details?: { failures?: PublishValidationFailure[] };
      };
    };
    return {
      code: payload.error?.code,
      failures: payload.error?.details?.failures,
    };
  } catch {
    return {};
  }
};

type ActionKind = "publish" | "unpublish";
type ParticipationDecision = "cancel" | "proceed";

const actionLabel: Record<ActionKind, string> = {
  publish: "Kompetisi diterbitkan.",
  unpublish: "Kompetisi ditarik ke draft dan semua pendaftaran dibatalkan.",
};

export const InstitutionCompetitionDetailShell = ({
  institutionSlug,
  competitionId,
  expectedUserId,
  initialPublishReadiness,
  canDecideParticipation,
}: {
  institutionSlug: string;
  competitionId: string;
  // Rule 16: the rendered-for user id, sent as `X-Expected-User-Id` on every mutation from here.
  expectedUserId: string;
  initialPublishReadiness: CompetitionPublishReadiness;
  canDecideParticipation: boolean;
}) => {
  const { openModal } = useModal();
  const { addToast } = useToast();
  const { begin: beginPageTransition } = usePageTransition();
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [hasActiveRegistrations, setHasActiveRegistrations] = useState(false);
  const [participation, setParticipation] = useState<ParticipationSummary | null>(null);
  // Seeded from the page's server answer, then refreshed by every `load()` — the same request that
  // refreshes the competition refreshes what the server would say about publishing it.
  const [publishReadiness, setPublishReadiness] =
    useState<CompetitionPublishReadiness>(initialPublishReadiness);
  // Whether the readiness above came from a live read. A refetch that FAILS leaves the answer
  // UNKNOWN rather than stale — the same rule the edit shell applies (F5): the server is still the
  // authority, so the control stays offered and pressing it sends the attempt, whose refusal arrives
  // as Indonesian text through `competition-publish-messages`. Holding the last known value would
  // disable the control on a reason nobody was shown.
  const [readinessIsKnown, setReadinessIsKnown] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  // Several lifecycle actions live side by side; the key records which one is running so only
  // that button spins while the rest stay locked.
  const [pendingAction, setPendingAction] = useState<ActionKind | null>(null);
  const isSubmitting = pendingAction !== null;

  const load = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) {
      const { code } = await extractError(response);
      addToast({
        type: "error",
        message: errorMessageFor(code, REFUSAL_COPY.load, REFUSAL_FALLBACK.load),
      });
      // The read failed, so the readiness on screen is no longer an answer to anything. Drop it.
      setReadinessIsKnown(false);
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as {
      competition: Competition;
      hasActiveRegistrations: boolean;
      participation: ParticipationSummary;
      publishReadiness?: CompetitionPublishReadiness;
    };
    setCompetition(data.competition);
    setHasActiveRegistrations(data.hasActiveRegistrations);
    setParticipation(data.participation);
    if (data.publishReadiness) setPublishReadiness(data.publishReadiness);
    // Set on every successful read, whether or not the optional key came with it: the flag records
    // whether the last READ succeeded, not whether that read carried a new answer (the edit shell's
    // A6 rule, applied here at the point it is introduced).
    setReadinessIsKnown(true);
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

  // Reports an outcome instead of toasting the refusal, so a pop-up can show it inside itself and
  // the page's own button can toast it.
  const requestAction = async (action: ActionKind): Promise<ModalOutcome> => {
    const url = `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionId)}/${action}`;
    const response = await sessionFetch(expectedUserId, url, { method: "POST" });
    if (!response.ok) {
      const { code, failures } = await extractError(response);
      // A publish refusal is translated from its code, never relayed. The server's message is
      // English and written for a log; the person who pressed the button gets Indonesian.
      if (action === "publish") {
        return {
          ok: false,
          message: resolveSessionMismatchMessage(
            code,
            resolvePublishRefusalToastText(code, failures),
          ),
        };
      }
      const message = errorMessageFor(code, REFUSAL_COPY.unpublish, REFUSAL_FALLBACK.unpublish);
      const failureText = formatFailures(failures);
      return { ok: false, message: failureText ? `${message} (${failureText})` : message };
    }
    addToast({ type: "success", message: actionLabel[action] });
    void load();
    return { ok: true };
  };

  const onAction = async (action: ActionKind) => {
    setPendingAction(action);
    const outcome = await requestAction(action);
    setPendingAction(null);
    if (!outcome.ok) addToast({ type: "error", message: outcome.message });
  };

  const requestParticipationDecision = async (
    decision: ParticipationDecision,
  ): Promise<ModalOutcome> => {
    const url = `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionId)}/participation-decision`;
    const response = await sessionFetch(expectedUserId, url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (!response.ok) {
      const { code } = await extractError(response);
      return {
        ok: false,
        message: errorMessageFor(code, REFUSAL_COPY.decision, REFUSAL_FALLBACK.decision),
      };
    }
    addToast({
      type: "success",
      message:
        decision === "cancel" ? "Kompetisi dibatalkan." : "Kompetisi dikonfirmasi tetap berjalan.",
    });
    void load();
    return { ok: true };
  };

  const requestDelete = async (): Promise<ModalOutcome> => {
    const response = await sessionFetch(
      expectedUserId,
      `/api/v1/competitions/${encodeURIComponent(competitionId)}`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 204) {
      const { code } = await extractError(response);
      return {
        ok: false,
        message: errorMessageFor(code, REFUSAL_COPY.delete, REFUSAL_FALLBACK.delete),
      };
    }
    // Deleting the draft leaves this page for the competition list.
    beginPageTransition("Menghapus draf…");
    window.location.href = `/institution/${encodeURIComponent(institutionSlug)}/competitions`;
    return { ok: true };
  };

  const confirmDelete = () => {
    if (!competition) return;
    openModal({
      title: "Hapus draf kompetisi ini?",
      body: `“${competition.title}” akan dihapus dan tidak dapat dikembalikan.`,
      alert: true,
      actions: [
        { label: "Batal" },
        { label: "Hapus kompetisi", variant: "primary", onClick: requestDelete },
      ],
    });
  };

  const confirmWithdrawPublication = () => {
    if (!competition) return;
    openModal({
      title: "Tarik publikasi kompetisi?",
      body: `Semua pendaftaran peserta untuk “${competition.title}” akan dibatalkan dan setiap peserta diberi tahu. Tindakan ini tidak dapat dibatalkan.`,
      alert: true,
      actions: [
        { label: "Batal" },
        { label: "Tarik", variant: "primary", onClick: () => requestAction("unpublish") },
      ],
    });
  };

  const confirmProceedDespiteMinimum = () => {
    openModal({
      title: "Tetap jalankan kompetisi?",
      body: "Kompetisi akan dikonfirmasi tetap berjalan meskipun minimum peserta belum tercapai. Setelah dikonfirmasi, kompetisi tidak dapat dibatalkan karena kekurangan peserta.",
      actions: [
        { label: "Batal" },
        {
          label: "Tetap jalankan",
          variant: "primary",
          onClick: () => requestParticipationDecision("proceed"),
        },
      ],
    });
  };

  const confirmCancelForMinimum = () => {
    openModal({
      title: "Batalkan kompetisi?",
      body: "Minimum peserta belum tercapai. Kompetisi akan tetap terlihat dengan status Dibatalkan, semua pendaftaran aktif dibatalkan, dan peserta diberi tahu. Tindakan ini tidak dapat dibatalkan.",
      alert: true,
      actions: [
        { label: "Kembali" },
        {
          label: "Batalkan",
          variant: "primary",
          onClick: () => requestParticipationDecision("cancel"),
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
          kind="not-found"
          titleIsPageHeading
          title="Kompetisi tidak ditemukan"
          description="Data kompetisi tidak dapat dimuat."
          action={{
            label: "Kembali ke daftar",
            href: `/institution/${institutionSlug}/competitions`,
          }}
        />
      </main>
    );
  }

  const isDraft = competition.status === "draft";
  const isPublished = competition.status === "published";
  const isCancelled = competition.cancelledAt !== null;
  // Whether the server is known to refuse. An answer the shell could not REFRESH is not an answer,
  // so an unknown readiness neither disables the control nor prints a reason against it.
  const publishIsBlockedByServer = readinessIsKnown && !publishReadiness.canPublish;
  // Every reason the server would refuse a publish, in the publish path's own order. The detail
  // shell has no form, so there are no client-side reasons to add after these.
  const publishBlockers = publishIsBlockedByServer
    ? publishReadiness.blockers.map(getPublishBlockerReason)
    : [];
  // When no date was entered the public page falls back to one derived from the event end; show
  // the organizer the same value, marked as the estimate it is.
  const resolvedAnnouncement = resolveResultAnnouncement(competition);
  const announcementIsDerived = resolvedAnnouncement.source === "derived";
  const publicPath = `/competitions/${encodeURIComponent(institutionSlug)}/${encodeURIComponent(competition.slug)}`;
  const publicUrl = `${window.location.origin}${publicPath}`;

  const copyPublicUrl = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      addToast({ type: "success", message: "Tautan disalin ke papan klip." });
    } catch {
      addToast({ type: "error", message: "Gagal menyalin tautan. Coba lagi." });
    }
  };

  return (
    <main className="page-shell app-page competition-management-page">
      <PageHeader
        title={competition.title}
        backHref={`/institution/${institutionSlug}/competitions`}
        backName="Kompetisi"
        titleMark={
          <span
            className="status-badge"
            data-status={getCompetitionHeaderPillTone({ status: competition.status, isCancelled })}
          >
            {isCancelled ? "Dibatalkan" : getCompetitionStatusLabel(competition.status)}
          </span>
        }
      />

      {isPublished && !isCancelled ? (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <h2>Kompetisi sudah terbit</h2>
            </div>
          </div>
          <p className="muted-copy">
            Bagikan tautan ini agar peserta dapat menemukan dan mendaftar.
          </p>
          <dl className="management-detail-grid">
            <div className="management-detail-wide">
              <dt>Tautan publik</dt>
              <dd className="data-text">{publicUrl}</dd>
            </div>
          </dl>
          <div className="record-actions">
            <Button
              type="button"
              variant="outline"
              leadingIcon={<Icon name="copy" size="sm" />}
              onClick={copyPublicUrl}
            >
              Salin tautan
            </Button>
            <ButtonLink href={publicPath} variant="link">
              Lihat halaman
            </ButtonLink>
          </div>
        </section>
      ) : null}

      <section className="content-section">
        <div className="section-heading">
          <div>
            <h2>Informasi kompetisi</h2>
          </div>
          <IconButtonLink
            href={`/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(
              competition.slug,
            )}/edit`}
            icon="edit"
            label="Ubah informasi kompetisi"
            variant="outline"
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
            <dd className="data-text">
              {competition.registrationStartAt ? (
                <LocalDate value={competition.registrationStartAt} format="longDateTime" />
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>Pendaftaran berakhir</dt>
            <dd className="data-text">
              {competition.registrationEndAt ? (
                <LocalDate value={competition.registrationEndAt} format="longDateTime" />
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>Acara mulai</dt>
            <dd className="data-text">
              {competition.eventStartAt ? (
                <LocalDate value={competition.eventStartAt} format="longDateTime" />
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>Acara berakhir</dt>
            <dd className="data-text">
              {competition.eventEndAt ? (
                <LocalDate value={competition.eventEndAt} format="longDateTime" />
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>Pengumuman hasil</dt>
            <dd className="data-text">
              {resolvedAnnouncement.at ? (
                <LocalDate value={resolvedAnnouncement.at} format="longDateTime" />
              ) : (
                "—"
              )}
              {announcementIsDerived ? " (perkiraan)" : ""}
            </dd>
          </div>
          <div>
            <dt>Diterbitkan</dt>
            <dd className="data-text">
              {competition.publishedAt ? (
                <LocalDate value={competition.publishedAt} format="longDateTime" />
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>Minimum peserta</dt>
            <dd className="data-text">
              {competition.minimumParticipantEntries?.toLocaleString("id-ID") ?? "—"}
            </dd>
          </div>
          <div>
            <dt>Konfirmasi peserta</dt>
            <dd className="data-text">
              {competition.participantConfirmationAt ? (
                <LocalDate value={competition.participantConfirmationAt} format="longDateTime" />
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
      </section>

      {participation &&
      competition.minimumParticipantEntries !== null &&
      competition.minimumParticipantEntries >= 1 ? (
        <section className="content-section">
          <div className="section-heading">
            <div>
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
                  variant="primary"
                  disabled={isSubmitting}
                  onClick={confirmProceedDespiteMinimum}
                >
                  Tetap jalankan
                </Button>
              ) : null}
              {participation.canCancel ? (
                <Button variant="outline" disabled={isSubmitting} onClick={confirmCancelForMinimum}>
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
            <h2>Aksi status</h2>
          </div>
        </div>
        {isDraft ? (
          <div className="stack-sm">
            <div className="record-actions">
              {publishIsBlockedByServer ? null : (
                <Button
                  onClick={() => onAction("publish")}
                  loading={pendingAction === "publish"}
                  disabled={isSubmitting}
                >
                  Terbitkan
                </Button>
              )}
              <Button variant="outline" onClick={confirmDelete} disabled={isSubmitting}>
                Hapus
              </Button>
            </div>
            {/* A disabled control has to say why, and it has to say it in the page rather than only
                through aria-describedby: the reasons can carry links, and nothing inside a described
                element is reachable by keyboard. */}
            {publishIsBlockedByServer ? (
              <div className="form-field-aside" id="publish-blocked-reason">
                <ul className="stack-xs">
                  {publishBlockers.map((reason) => (
                    <li key={reason.code}>
                      {reason.text}
                      {reason.link ? (
                        <>
                          {" "}
                          <Link
                            href={resolvePublishReasonHref(reason.link.kind, {
                              institutionSlug,
                              competitionSlug: competition.slug,
                            })}
                          >
                            {reason.link.label}
                          </Link>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        {isPublished && !isCancelled ? (
          <div className="stack-sm">
            <div className="record-actions">
              <Button
                variant="outline"
                onClick={confirmWithdrawPublication}
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
