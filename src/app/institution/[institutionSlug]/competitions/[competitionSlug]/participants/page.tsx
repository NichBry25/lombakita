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
import { ParticipantTeamMembers } from "./participant-team-members";
import {
  ButtonLink,
  EmptyState,
  Icon,
  PageHeader,
  Pagination,
  Table,
  TableExpandToggle,
  TableNameLink,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { LocalDate } from "@/components/ui/local-date";
import { formatDisplayToken } from "@/lib/text/capitalize";

type Props = {
  params: Promise<{ institutionSlug: string; competitionSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const REGISTRATION_STATUS_LABELS: Record<string, string> = {
  confirmed: "Dikonfirmasi",
  cancelled: "Dibatalkan",
};

const getRegistrationStatusLabel = (status: string): string =>
  REGISTRATION_STATUS_LABELS[status] ?? formatDisplayToken(status);

const registrationStatusTone = (status: ParticipantRecord["status"]): string => {
  if (status === "confirmed") return "open";
  if (status === "cancelled") return "closed";
  return "awaiting";
};

const describeSubmission = (submission: ParticipantRecord["submission"]): string => {
  if (submission === null) return "Tidak ada";
  return submission.finalized ? "Finalisasi" : "Diunggah";
};

const PARTICIPANT_COLUMNS: readonly TableColumn[] = [
  { key: "name", header: "Peserta", kind: "name" },
  { key: "type", header: "Tipe", kind: "text" },
  { key: "status", header: "Status", kind: "pill" },
  { key: "members", header: "Anggota", kind: "number" },
  { key: "submission", header: "Submission", kind: "text" },
  { key: "review", header: "Tinjauan", kind: "pill" },
  { key: "documents", header: "Dokumen", kind: "pill" },
  { key: "registeredAt", header: "Terdaftar", kind: "date" },
];

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
    if (e instanceof AccessError && e.code === "account_state_unavailable") throw e;
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
  const hasActiveFilter = status !== "all" || type !== "all";

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

  const buildParticipantRow = (participant: ParticipantRecord): TableRowData => {
    const name = participantLabel(participant);
    const team = participant.registrationType === "team" ? participant.team : null;
    const latestRequest = latestRequestByRegistration.get(participant.registrationId);

    return {
      key: participant.registrationId,
      cells: {
        name: (
          <TableNameLink
            href={`${path}/${participant.registrationId}`}
            aria-label={`Tinjau pendaftaran ${name}`}
          >
            {name}
          </TableNameLink>
        ),
        type: participant.registrationType === "team" ? "Tim" : "Individu",
        status: (
          <span className="status-badge" data-status={registrationStatusTone(participant.status)}>
            {getRegistrationStatusLabel(participant.status)}
          </span>
        ),
        members: team ? (
          <TableExpandToggle label={`Daftar anggota ${team.teamName}`}>
            {team.activeMemberCount}
          </TableExpandToggle>
        ) : null,
        submission: describeSubmission(participant.submission),
        review: (
          <span className="status-badge">
            {REVIEW_STATUS_LABELS[participant.internalReviewStatus]}
          </span>
        ),
        documents: latestRequest ? (
          <span
            className="status-badge"
            data-status={DOCUMENT_REQUEST_STATUS_TONES[latestRequest.display.status]}
          >
            {DOCUMENT_REQUEST_STATUS_LABELS[latestRequest.display.status]}
          </span>
        ) : null,
        registeredAt: <LocalDate value={participant.registeredAt} format="shortDate" />,
      },
      band: team ? <ParticipantTeamMembers team={team} /> : undefined,
    };
  };

  const participantRows = result.participants.map(buildParticipantRow);

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
        backName={competitionTitle}
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
          data-variant="link"
          data-size="sm"
        >
          <Icon name="download" size="sm" />
          <span>Pendaftar</span>
        </a>
        <a
          href={`/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/export/submissions`}
          download
          className="ui-button"
          data-variant="link"
          data-size="sm"
        >
          <Icon name="download" size="sm" />
          <span>Submission</span>
        </a>
        <a
          href={`/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/export/results`}
          download
          className="ui-button"
          data-variant="link"
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

      {/* The one node that is already on the page when the filter changes, so a screen reader hears
          the new count. The empty state appears together with its text and is never announced. */}
      <p className="sr-only" role="status">
        {`${result.pagination.totalCount} peserta`}
      </p>

      {result.pagination.totalCount === 0 && !hasActiveFilter ? (
        <EmptyState
          kind="nothing-yet"
          title="Belum ada peserta"
          description="Peserta akan muncul di sini setelah ada yang mendaftar."
        />
      ) : result.pagination.totalCount === 0 ? (
        <EmptyState
          kind="no-match"
          title="Belum ada peserta yang cocok"
          description="Coba ubah filter status atau tipe untuk melihat peserta lain."
          action={{ label: "Bersihkan filter", href: path }}
        />
      ) : (
        <Table label="Peserta" columns={PARTICIPANT_COLUMNS} rows={participantRows} />
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
