import { notFound, redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { ParticipantsFilterForm } from "./filter-form";
import { AccessError } from "@/server/auth/access-core";
import { requireRolePage } from "@/server/auth/page-guard";
import { getDb } from "@/server/db/client";
import { CompetitionError } from "@/server/competitions/competition-core";
import { getCompetitionIdByInstitutionAndSlug } from "@/server/competitions/competition-service";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import {
  listCompetitionParticipants,
  type ParticipantRecord,
} from "@/server/participants/participant-service";
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
  try {
    competitionId = await getCompetitionIdByInstitutionAndSlug(
      institutionSlug,
      competitionSlug,
      db,
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof CompetitionError) notFound();
    throw error;
  }

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
        title="Peserta"
        description={`Tinjau pendaftaran, submission, dan hasil untuk ${competitionSlug}.`}
        backHref={`/institution/${institutionSlug}/competitions/${competitionSlug}`}
        backLabel="Kembali"
      />

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
