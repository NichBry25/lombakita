import Link from "next/link";
import { redirect } from "next/navigation";
import { SecondRoleBanner } from "@/components/auth/second-role-banner";
import { ButtonLink, EmptyState, Icon, PageHeader } from "@/components/ui";
import { formatDisplayToken } from "@/lib/text/capitalize";
import { getCurrentSession } from "@/server/auth/session";
import { getUnverifiedRoles } from "@/server/auth/role-verification";
import {
  listCandidateIndividualRegistrations,
  listCandidateTeamRegistrations,
} from "@/server/candidate-registrations/candidate-registration-service";
import { deriveUpcomingDeadlines } from "@/server/candidate-registrations/deadline-utils";
import { listSavedCompetitions } from "@/server/saved-competitions/saved-competition-service";

const getCandidateRegistrationStatusLabel = (status: string): string => {
  if (status === "confirmed") return "Terdaftar";
  if (status === "cancelled") return "Dibatalkan";
  return formatDisplayToken(status);
};

export default async function CandidateDashboardPage() {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/candidate-dashboard");
  }

  const unverified = await getUnverifiedRoles(session.user.id);

  // DEC-0060 — access to role-scoped surfaces is derived per-request from verification state.
  if (unverified.includes("candidate")) {
    redirect("/auth/verify-role?as=candidate");
  }

  const showRecruiterBanner = unverified.includes("recruiter");

  const [individualRegs, teamRegs, savedResult] = await Promise.all([
    listCandidateIndividualRegistrations(session.user.id),
    listCandidateTeamRegistrations(session.user.id),
    listSavedCompetitions(session.user.id, { limit: 5 }),
  ]);

  const upcomingDeadlines = deriveUpcomingDeadlines([...individualRegs, ...teamRegs]);

  return (
    <main className="page-shell app-page candidate-dashboard">
      <PageHeader
        eyebrow="Ruang kandidat"
        title="Dasbor kandidat"
        description="Pantau pendaftaran, tenggat, hasil, dan peluang yang kamu simpan."
        actions={
          <>
            <ButtonLink
              href="/candidate-dashboard/profile"
              variant="primary"
              size="sm"
              leadingIcon={<Icon name="settings" size="sm" />}
            >
              Pengaturan
            </ButtonLink>
          </>
        }
      />

      {showRecruiterBanner ? (
        <SecondRoleBanner unverifiedRole="recruiter" userId={session.user.id} />
      ) : null}

      <section className="summary-grid" aria-label="Ringkasan kandidat">
        <div className="candidate-summary-card">
          <span className="candidate-summary-icon">
            <Icon name="calendar" size="md" />
          </span>
          <span className="candidate-summary-value data-text">{upcomingDeadlines.length}</span>
          <span>Tenggat mendatang</span>
        </div>
        <div className="candidate-summary-card">
          <span className="candidate-summary-icon">
            <Icon name="user" size="md" />
          </span>
          <span className="candidate-summary-value data-text">{individualRegs.length}</span>
          <span>Pendaftaran individu</span>
        </div>
        <div className="candidate-summary-card">
          <span className="candidate-summary-icon">
            <Icon name="users" size="md" />
          </span>
          <span className="candidate-summary-value data-text">{teamRegs.length}</span>
          <span>Pendaftaran tim</span>
        </div>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Prioritas waktu</p>
            <h2>Tenggat mendatang</h2>
          </div>
        </div>
        {upcomingDeadlines.length === 0 ? (
          <EmptyState
            icon="calendar"
            title="Tidak ada tenggat mendatang."
            description="Tenggat pendaftaran dan tanggal mulai yang relevan akan muncul di sini."
          />
        ) : (
          <ul className="record-list">
            {upcomingDeadlines.map((deadline, index) => (
              <li key={index} className="record-row candidate-deadline-row">
                <span className="candidate-deadline-date data-text">
                  {deadline.date.toLocaleDateString("id-ID", { day: "2-digit", month: "short" })}
                </span>
                <div className="record-row-main">
                  <span className="record-row-title">{deadline.competitionTitle}</span>
                  <span className="record-meta">
                    {deadline.label === "registration_closes"
                      ? "Pendaftaran tutup"
                      : "Acara dimulai"}
                    {" · "}
                    {deadline.date.toLocaleDateString("id-ID", {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Partisipasi</p>
            <h2>Pendaftaran individu</h2>
          </div>
        </div>
        {individualRegs.length === 0 ? (
          <EmptyState
            icon="user"
            title="Belum ada pendaftaran individu."
            description="Kompetisi yang kamu daftarkan sendiri akan tersusun di sini."
          />
        ) : (
          <ul className="record-list">
            {individualRegs.map((reg) => {
              const deadline =
                reg.registrationEndAt && reg.registrationEndAt > new Date()
                  ? reg.registrationEndAt
                  : reg.eventStartAt && reg.eventStartAt > new Date()
                    ? reg.eventStartAt
                    : null;
              return (
                <li key={reg.id} className="record-row">
                  <div className="record-row-main">
                    <Link
                      href={`/competitions/${reg.institutionSlug}/${reg.competitionSlug}`}
                      className="record-row-title"
                    >
                      {reg.competitionTitle}
                    </Link>
                    <span className="record-meta">
                      {deadline
                        ? deadline.toLocaleDateString("id-ID", { day: "numeric", month: "long" })
                        : "Tanpa tenggat aktif"}
                    </span>
                  </div>
                  <div className="record-actions">
                    <span
                      className="status-badge"
                      data-status={
                        reg.registrationStatus === "confirmed"
                          ? "open"
                          : reg.registrationStatus === "cancelled"
                            ? "closed"
                            : undefined
                      }
                    >
                      {getCandidateRegistrationStatusLabel(reg.registrationStatus)}
                    </span>
                    <ButtonLink
                      variant="ghost"
                      size="sm"
                      href={`/competitions/${reg.institutionSlug}/${reg.competitionSlug}/registration/`}
                    >
                      Detail
                    </ButtonLink>
                    <ButtonLink
                      variant="outline"
                      size="sm"
                      href={`/candidate-dashboard/registrations/${reg.id}`}
                    >
                      Submission
                    </ButtonLink>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Kolaborasi</p>
            <h2>Pendaftaran tim</h2>
          </div>
        </div>
        {teamRegs.length === 0 ? (
          <EmptyState
            icon="users"
            title="Belum ada pendaftaran tim."
            description="Tim yang kamu pimpin atau ikuti akan muncul di sini."
          />
        ) : (
          <ul className="record-list">
            {teamRegs.map((reg) => {
              const deadline =
                reg.registrationEndAt && reg.registrationEndAt > new Date()
                  ? reg.registrationEndAt
                  : reg.eventStartAt && reg.eventStartAt > new Date()
                    ? reg.eventStartAt
                    : null;
              return (
                <li key={reg.id} className="record-row">
                  <div className="record-row-main">
                    <Link
                      href={`/competitions/${reg.institutionSlug}/${reg.competitionSlug}`}
                      className="record-row-title"
                    >
                      {reg.competitionTitle}
                    </Link>
                    <span className="record-meta">
                      {reg.teamName} · {reg.isCaptain ? "Kapten" : "Anggota"}
                      {deadline
                        ? ` · ${deadline.toLocaleDateString("id-ID", { day: "numeric", month: "long" })}`
                        : ""}
                    </span>
                  </div>
                  <div className="record-actions">
                    <span
                      className="status-badge"
                      data-status={
                        reg.registrationStatus === "confirmed"
                          ? "open"
                          : reg.registrationStatus === "cancelled"
                            ? "closed"
                            : undefined
                      }
                    >
                      {getCandidateRegistrationStatusLabel(reg.registrationStatus)}
                    </span>
                    <ButtonLink
                      variant="ghost"
                      size="sm"
                      href={`/competitions/${reg.institutionSlug}/${reg.competitionSlug}/registration/`}
                    >
                      Detail
                    </ButtonLink>
                    <ButtonLink
                      variant="outline"
                      size="sm"
                      href={`/candidate-dashboard/registrations/${reg.id}`}
                    >
                      Submission
                    </ButtonLink>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="candidate-callout inset-panel card-padding-lg">
        <span className="detail-info-icon">
          <Icon name="trophy" size="lg" />
        </span>
        <div className="stack-xs">
          <p className="eyebrow">Hasil kompetisi</p>
          <h2>Hasil yang telah dipublikasikan</h2>
          <p>Lihat keputusan penyelenggara untuk pendaftaran yang kamu ikuti.</p>
        </div>
        <ButtonLink href="/candidate-dashboard/results" variant="outline" size="sm">
          Lihat semua hasil
        </ButtonLink>
      </section>

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Koleksi pribadi</p>
            <h2>Tersimpan</h2>
          </div>
          <ButtonLink href="/saved" variant="ghost" size="sm">
            Lihat semua
          </ButtonLink>
        </div>
        {savedResult.data.length === 0 ? (
          <EmptyState
            icon="bookmark"
            title="Belum ada kompetisi yang disimpan."
            description="Simpan peluang dari halaman detail untuk membacanya kembali di sini."
          />
        ) : (
          <ul className="record-list">
            {savedResult.data.map((item) => (
              <li
                key={item.competitionId}
                className="record-row"
                data-unavailable={item.savedStatus === "unavailable" ? "true" : undefined}
              >
                <div className="record-row-main">
                  {item.savedStatus === "available" ? (
                    <Link
                      href={`/competitions/${item.institutionSlug}/${item.slug}`}
                      className="record-row-title"
                    >
                      {item.title}
                    </Link>
                  ) : (
                    <span className="record-row-title">{item.title}</span>
                  )}
                  <span className="record-meta">{item.institutionName}</span>
                </div>
                {item.savedStatus === "unavailable" ? (
                  <span className="status-badge" data-status="closed">
                    Tidak tersedia
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
