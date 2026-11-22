import type { ReactNode } from "react";
import { SecondRoleBanner } from "@/components/auth/second-role-banner";
import {
  ButtonLink,
  Card,
  EmptyState,
  Icon,
  IconButtonLink,
  LinkCard,
  PageHeader,
  PageSection,
} from "@/components/ui";
import { LocalDate } from "@/components/ui/local-date";
import { formatDisplayToken } from "@/lib/text/capitalize";
import { requireRolePage } from "@/server/auth/page-guard";
import { getUnverifiedRoles } from "@/server/auth/role-verification";
import {
  listCandidateIndividualRegistrations,
  listCandidateTeamRegistrations,
  type IndividualRegistrationSummary,
} from "@/server/candidate-registrations/candidate-registration-service";
import { deriveUpcomingDeadlines } from "@/server/candidate-registrations/deadline-utils";
import { listSavedCompetitions } from "@/server/saved-competitions/saved-competition-service";
import { isSubmissionWindowOpen } from "@/server/submissions/submission-core";

const getCandidateRegistrationStatusLabel = (status: string): string => {
  if (status === "confirmed") return "Terdaftar";
  if (status === "cancelled") return "Dibatalkan";
  return formatDisplayToken(status);
};

const getRegistrationPillStatus = (registrationStatus: string): string | undefined => {
  if (registrationStatus === "confirmed") return "open";
  if (registrationStatus === "cancelled") return "closed";
  return undefined;
};

const getNextUpcomingDate = (reg: IndividualRegistrationSummary): Date | null => {
  const now = new Date();
  if (reg.registrationEndAt && reg.registrationEndAt > now) return reg.registrationEndAt;
  if (reg.eventStartAt && reg.eventStartAt > now) return reg.eventStartAt;
  return null;
};

// A cancelled registration blocks every submission operation on the server, so it is never open.
const isSubmissionOpenFor = (reg: IndividualRegistrationSummary): boolean =>
  reg.registrationStatus !== "cancelled" && isSubmissionWindowOpen(reg);

function RegistrationRow({
  reg,
  metaLine,
}: {
  reg: IndividualRegistrationSummary;
  metaLine: ReactNode;
}) {
  const submissionIsOpen = isSubmissionOpenFor(reg);

  return (
    <LinkCard
      as="li"
      href={`/competitions/${reg.institutionSlug}/${reg.competitionSlug}/registration/`}
      title={reg.competitionTitle}
      trailing={
        <>
          <span
            className="status-badge"
            data-status={getRegistrationPillStatus(reg.registrationStatus)}
          >
            {getCandidateRegistrationStatusLabel(reg.registrationStatus)}
          </span>
          <ButtonLink
            href={`/candidate-dashboard/registrations/${reg.id}`}
            variant="link"
            size="sm"
            leadingIcon={<Icon name={submissionIsOpen ? "upload" : "eye"} size="sm" />}
          >
            {submissionIsOpen ? "Kirim karya" : "Lihat karya"}
          </ButtonLink>
        </>
      }
    >
      <span className="record-meta">{metaLine}</span>
    </LinkCard>
  );
}

export default async function CandidateDashboardPage() {
  const session = await requireRolePage("candidate", {
    callbackPath: "/candidate-dashboard",
    missingRoleRedirect: "/auth/verify-role?as=candidate",
  });

  // Onboarding state, not authorization: drives whether the second-role banner is offered.
  const unverified = await getUnverifiedRoles(session.user.id);
  const showRecruiterBanner = unverified.includes("recruiter");

  const [individualRegs, teamRegs, savedResult] = await Promise.all([
    listCandidateIndividualRegistrations(session.user.id),
    listCandidateTeamRegistrations(session.user.id),
    listSavedCompetitions(session.user.id, { limit: 5 }),
  ]);

  const upcomingDeadlines = deriveUpcomingDeadlines([...individualRegs, ...teamRegs]);

  // The link to the competitions list appears once, under the first section that is empty.
  const emptySectionsFromTop = [
    upcomingDeadlines.length === 0 ? "deadlines" : null,
    individualRegs.length === 0 ? "individual" : null,
    teamRegs.length === 0 ? "team" : null,
    savedResult.data.length === 0 ? "saved" : null,
  ].filter((section) => section !== null);
  const sectionWithExploreLink = emptySectionsFromTop[0];
  const exploreAction = { label: "Jelajahi kompetisi", href: "/competitions" };

  return (
    <main className="page-shell app-page candidate-dashboard">
      <PageHeader
        title="Dasbor kandidat"
        action={{
          kind: "icon",
          control: (
            <IconButtonLink
              href="/candidate-dashboard/profile"
              icon="settings"
              variant="outline"
              label="Pengaturan"
            />
          ),
        }}
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

      <PageSection title="Tenggat mendatang">
        {upcomingDeadlines.length === 0 ? (
          <EmptyState
            kind="nothing-yet"
            size="compact"
            title="Tidak ada tenggat mendatang"
            description="Daftar kompetisi untuk melihat tenggatnya di sini."
            action={sectionWithExploreLink === "deadlines" ? exploreAction : undefined}
          />
        ) : (
          <ul className="record-list">
            {upcomingDeadlines.map((deadline, index) => (
              <li key={index} className="record-row candidate-deadline-row">
                <span className="candidate-deadline-date data-text">
                  <LocalDate value={deadline.date} format="dayMonthShort" />
                </span>
                <div className="record-row-main">
                  <span className="record-row-title">{deadline.competitionTitle}</span>
                  <span className="record-meta">
                    {deadline.label === "registration_closes"
                      ? "Pendaftaran tutup"
                      : "Acara dimulai"}
                    {" · "}
                    <LocalDate value={deadline.date} format="longDate" />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PageSection>

      <PageSection title="Pendaftaran individu">
        {individualRegs.length === 0 ? (
          <EmptyState
            kind="nothing-yet"
            size="compact"
            title="Belum ada pendaftaran individu"
            description="Kompetisi yang kamu daftarkan sendiri akan muncul di sini."
            action={sectionWithExploreLink === "individual" ? exploreAction : undefined}
          />
        ) : (
          <ul className="record-list">
            {individualRegs.map((reg) => {
              const deadline = getNextUpcomingDate(reg);
              return (
                <RegistrationRow
                  key={reg.id}
                  reg={reg}
                  metaLine={
                    deadline ? (
                      <LocalDate value={deadline} format="dayMonth" />
                    ) : (
                      "Tanpa tenggat aktif"
                    )
                  }
                />
              );
            })}
          </ul>
        )}
      </PageSection>

      <PageSection title="Pendaftaran tim">
        {teamRegs.length === 0 ? (
          <EmptyState
            kind="nothing-yet"
            size="compact"
            title="Belum ada pendaftaran tim"
            description="Tim yang kamu pimpin atau ikuti akan muncul di sini."
            action={sectionWithExploreLink === "team" ? exploreAction : undefined}
          />
        ) : (
          <ul className="record-list">
            {teamRegs.map((reg) => {
              const deadline = getNextUpcomingDate(reg);
              return (
                <RegistrationRow
                  key={reg.id}
                  reg={reg}
                  metaLine={
                    <>
                      {reg.teamName} · {reg.isCaptain ? "Kapten" : "Anggota"}
                      {deadline ? (
                        <>
                          {" "}
                          · <LocalDate value={deadline} format="dayMonth" />
                        </>
                      ) : null}
                    </>
                  }
                />
              );
            })}
          </ul>
        )}
      </PageSection>

      <LinkCard href="/candidate-dashboard/results" title="Hasil yang telah dipublikasikan">
        <p className="record-meta">
          Lihat keputusan penyelenggara untuk pendaftaran yang kamu ikuti.
        </p>
      </LinkCard>

      <PageSection
        title="Tersimpan"
        action={
          savedResult.data.length > 0 ? (
            <ButtonLink href="/saved" variant="link" size="sm">
              Lihat semua
            </ButtonLink>
          ) : null
        }
      >
        {savedResult.data.length === 0 ? (
          <EmptyState
            kind="nothing-yet"
            size="compact"
            title="Belum ada kompetisi yang disimpan"
            description="Simpan peluang dari halaman detail untuk membacanya kembali di sini."
            action={sectionWithExploreLink === "saved" ? exploreAction : undefined}
          />
        ) : (
          <ul className="record-list">
            {savedResult.data.map((item) =>
              item.savedStatus === "available" ? (
                <LinkCard
                  key={item.competitionId}
                  as="li"
                  href={`/competitions/${item.institutionSlug}/${item.slug}`}
                  title={item.title}
                >
                  <span className="record-meta">{item.institutionName}</span>
                </LinkCard>
              ) : (
                <Card as="li" key={item.competitionId} className="candidate-saved-unavailable">
                  <div className="ui-link-card-main">
                    <span className="candidate-saved-unavailable-title">{item.title}</span>
                    <span className="record-meta">{item.institutionName}</span>
                  </div>
                  <span className="status-badge" data-status="closed">
                    Tidak tersedia
                  </span>
                </Card>
              ),
            )}
          </ul>
        )}
      </PageSection>
    </main>
  );
}
