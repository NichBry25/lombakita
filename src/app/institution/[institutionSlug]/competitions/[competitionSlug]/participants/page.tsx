import { notFound, redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { ParticipantsFilterForm } from "./filter-form";
import { AccessError } from "@/server/auth/access-core";
import { requireRolePage } from "@/server/auth/page-guard";
import { getDb } from "@/server/db/client";
import { CompetitionError } from "@/server/competitions/competition-core";
import {
  getCompetitionIdentityByInstitutionAndSlug,
  loadCompetitionPricing,
} from "@/server/competitions/competition-service";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import { truncateText } from "@/lib/text/truncate";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import {
  listCompetitionParticipants,
  type ParticipantRecord,
} from "@/server/participants/participant-service";
import {
  listDocumentRequestsForCompetition,
  listRegistrationIdsEligibleForDocumentRequest,
} from "@/server/registration-documents/registration-document-service";
import { MAX_BATCH_REGISTRATIONS } from "@/server/registration-documents/registration-document-core";
import {
  DOCUMENT_REQUEST_STATUS_LABELS,
  DOCUMENT_REQUEST_STATUS_TONES,
  isOpenRequestStatus,
} from "@/lib/registration-documents/request-status";
import { BatchDocumentRequestForm, type BatchTarget } from "./batch-document-request-form";
import { REVIEW_STATUS_LABELS } from "./review-status-labels";
import { ButtonLink, EmptyState, Icon, PageHeader, Pagination } from "@/components/ui";
import { formatDisplayToken } from "@/lib/text/capitalize";

type Props = {
  params: Promise<{ institutionSlug: string; competitionSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const REGISTRATION_STATUS_LABELS: Record<string, string> = {
  confirmed: "Dikonfirmasi",
  cancelled: "Dibatalkan",
  pending: "Menunggu",
};

const getRegistrationStatusLabel = (status: string): string =>
  REGISTRATION_STATUS_LABELS[status] ?? formatDisplayToken(status);

export default async function ParticipantsPage({ params, searchParams }: Props) {
  const { institutionSlug, competitionSlug } = await params;
  const sp = await searchParams;

  const path = `/institution/${institutionSlug}/competitions/${competitionSlug}/participants`;
  const session = await requireRolePage("recruiter", { callbackPath: path });

  const db = getDb();
  let institutionId: string;
  try {
    ({ institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug.trim().toLowerCase(),
      db,
    ));
  } catch (e) {
    if (e instanceof AccessError) redirect("/");
    throw e;
  }

  let competitionId: string;
  let competitionTitle: string;
  try {
    ({ id: competitionId, title: competitionTitle } =
      await getCompetitionIdentityByInstitutionAndSlug(institutionSlug, competitionSlug, db));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof CompetitionError) notFound();
    throw error;
  }

  // Gates the payments link below. Reusing the pricing read the charging gate and the edit
  // classifier already share, rather than adding a third query that reads the same three columns.
  const { feeAmount } = await loadCompetitionPricing(competitionId, db);
  const isPaid = isPaidCompetition(feeAmount);

  const resolveParam = (val: string | string[] | undefined, fallback: string): string => {
    if (!val) return fallback;
    return Array.isArray(val) ? (val[0] ?? fallback) : val;
  };

  const status = resolveParam(sp.status, "all");
  const type = resolveParam(sp.type, "all");
  const page = parseInt(resolveParam(sp.page, "1"), 10);
  const limit = 20;

  const result = await listCompetitionParticipants(
    institutionId,
    competitionId,
    {
      status: status as "all" | "confirmed" | "cancelled",
      type: type as "all" | "individual" | "team",
      page,
      limit,
    },
    db,
  );

  // One query for the whole competition, indexed by registration, so the table can show each
  // participant's document state without a per-row lookup. Only the newest request per participant
  // is displayed — the list is already ordered newest-first.
  const [documentRequests, eligibleRegistrationIds] = await Promise.all([
    listDocumentRequestsForCompetition(institutionId, competitionId, {}, db),
    listRegistrationIdsEligibleForDocumentRequest(institutionId, competitionId, db),
  ]);
  const latestRequestByRegistration = new Map<string, (typeof documentRequests)[number]>();
  for (const request of documentRequests) {
    if (!latestRequestByRegistration.has(request.registrationId)) {
      latestRequestByRegistration.set(request.registrationId, request);
    }
  }

  const participantLabel = (participant: ParticipantRecord): string => {
    if (participant.registrationType === "team" && participant.team) {
      return participant.team.teamName;
    }
    return participant.candidate?.displayName ?? participant.candidate?.username ?? "Peserta";
  };

  const hasOpenRequest = (registrationId: string): boolean => {
    const latest = latestRequestByRegistration.get(registrationId);
    return latest ? isOpenRequestStatus(latest.status) : false;
  };

  const batchTargets: BatchTarget[] = result.participants
    .filter((participant) => participant.status !== "cancelled")
    .map((participant) => ({
      registrationId: participant.registrationId,
      label: participantLabel(participant),
      hasOpenRequest: hasOpenRequest(participant.registrationId),
    }));

  const buildSearchParams = (overrides: Record<string, string>): string => {
    const p = new URLSearchParams();
    if (status !== "all") p.set("status", status);
    if (type !== "all") p.set("type", type);
    for (const [k, v] of Object.entries(overrides)) p.set(k, v);
    const qs = p.toString();
    return qs ? `?${qs}` : "";
  };

  const buildPageHref = (target: number): string =>
    `${path}${buildSearchParams({ page: String(target) })}`;

  return (
    <main className="page-shell app-page participants-page">
      <PageHeader
        // The name is capped so a long title cannot push the heading across the whole page; the
        // full title stays available in the description below it.
        title={`Peserta ${truncateText(competitionTitle, 38)}`}
        description={`Tinjau pendaftaran, submission, dan hasil untuk ${competitionTitle}.`}
        backHref={`/institution/${institutionSlug}/competitions/${competitionSlug}`}
        backLabel="Kembali"
      />

      {/* Shown only on a PAID competition. A free one has no bukti transfer and never will, so the
          link would lead every organiser who tried it to a permanently empty queue. */}
      {isPaid ? (
        <section className="export-toolbar glass-chrome" aria-label="Pembayaran peserta">
          <ButtonLink
            href={`/institution/${institutionSlug}/competitions/${competitionSlug}/payments`}
            variant="outline"
            size="sm"
          >
            Verifikasi pembayaran
          </ButtonLink>
        </section>
      ) : null}

      <section className="export-toolbar glass-chrome" aria-label="Ekspor data kompetisi">
        <a
          href={`/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/export/registrants`}
          download
          className="ui-button"
          data-variant="outline"
          data-size="sm"
        >
          <Icon name="download" size="sm" />
          <span>Pendaftar</span>
        </a>
        <a
          href={`/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/export/submissions`}
          download
          className="ui-button"
          data-variant="outline"
          data-size="sm"
        >
          <Icon name="download" size="sm" />
          <span>Submission</span>
        </a>
        <a
          href={`/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/export/results`}
          download
          className="ui-button"
          data-variant="outline"
          data-size="sm"
        >
          <Icon name="download" size="sm" />
          <span>Hasil</span>
        </a>
      </section>

      <section className="summary-grid participant-summary" aria-label="Ringkasan peserta">
        <div className="summary-stat">
          <span>Total</span>
          <strong className="data-text">{result.counts.total}</strong>
        </div>
        <div className="summary-stat">
          <span>Dikonfirmasi</span>
          <strong className="data-text">{result.counts.confirmed}</strong>
        </div>
        <div className="summary-stat">
          <span>Menunggu</span>
          <strong className="data-text">{result.counts.pending}</strong>
        </div>
        <div className="summary-stat">
          <span>Dibatalkan</span>
          <strong className="data-text">{result.counts.cancelled}</strong>
        </div>
        <div className="summary-stat">
          <span>Ada submission</span>
          <strong className="data-text">{result.counts.withSubmissions}</strong>
        </div>
        <div className="summary-stat">
          <span>Finalisasi</span>
          <strong className="data-text">{result.counts.withFinalizedSubmissions}</strong>
        </div>
      </section>

      <ParticipantsFilterForm path={path} status={status} type={type} />

      <BatchDocumentRequestForm
        institutionSlug={institutionSlug}
        competitionId={competitionId}
        targets={batchTargets}
        allEligibleIds={eligibleRegistrationIds}
        maxBatchSize={MAX_BATCH_REGISTRATIONS}
      />

      {result.participants.length === 0 ? (
        <EmptyState
          icon="users"
          title="Tidak ada peserta."
          description="Coba ubah filter, atau kembali lagi setelah pendaftaran dimulai."
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table participants-table">
            <thead>
              <tr>
                <th>Tipe</th>
                <th>Peserta</th>
                <th>Status</th>
                <th>Anggota</th>
                <th>Submission</th>
                <th>Tinjauan</th>
                <th>Dokumen</th>
                <th>Terdaftar</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {result.participants.map((p: ParticipantRecord) => (
                <tr key={p.registrationId}>
                  <td>{p.registrationType === "team" ? "Tim" : "Individu"}</td>
                  <td>
                    {p.registrationType === "individual" && p.candidate ? (
                      (p.candidate.displayName ?? p.candidate.username)
                    ) : p.team ? (
                      <details className="participant-team-details">
                        <summary>
                          {p.team.teamName} ({p.team.activeMemberCount} anggota)
                        </summary>
                        <ul>
                          {p.team.members.map((m) => (
                            <li key={m.userId}>
                              {m.displayName ?? m.username}
                              {m.isCaptain ? " (Kapten)" : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span
                      className="status-badge"
                      data-status={
                        p.status === "confirmed"
                          ? "open"
                          : p.status === "cancelled"
                            ? "closed"
                            : "closing"
                      }
                    >
                      {getRegistrationStatusLabel(p.status)}
                    </span>
                  </td>
                  <td className="data-text">
                    {p.registrationType === "team" && p.team ? p.team.activeMemberCount : "—"}
                  </td>
                  <td>
                    {p.submission === null
                      ? "Tidak ada"
                      : p.submission.finalized
                        ? "Finalisasi"
                        : "Diunggah"}
                  </td>
                  <td>
                    <span className="status-badge">
                      {REVIEW_STATUS_LABELS[p.internalReviewStatus]}
                    </span>
                  </td>
                  <td>
                    {(() => {
                      const latest = latestRequestByRegistration.get(p.registrationId);
                      if (!latest) return <span className="muted-copy">—</span>;
                      return (
                        <span
                          className="status-badge"
                          data-status={DOCUMENT_REQUEST_STATUS_TONES[latest.display.status]}
                        >
                          {DOCUMENT_REQUEST_STATUS_LABELS[latest.display.status]}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="data-text">
                    {new Date(p.registeredAt).toLocaleDateString("id-ID")}
                  </td>
                  <td>
                    <ButtonLink href={`${path}/${p.registrationId}`} variant="outline" size="sm">
                      Tinjau
                    </ButtonLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={result.pagination.page}
        totalPages={result.pagination.totalPages}
        label="Halaman peserta"
        hrefFor={buildPageHref}
      />
    </main>
  );
}
