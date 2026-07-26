import Link from "next/link";
import { redirect } from "next/navigation";
import { SecondRoleBanner } from "@/components/auth/second-role-banner";
import { Icon, PageHeader } from "@/components/ui";
import { getCurrentSession } from "@/server/auth/session";
import { getUnverifiedRoles } from "@/server/auth/role-verification";
import { getRecruiterTierForAccount } from "@/server/auth/recruiter-tier";
import { getLatestRecruiterVerificationForUser } from "@/server/recruiter-verification/recruiter-verification-service";
import {
  findOwnedPersonalInstitution,
  listUserInstitutionMemberships,
} from "@/server/institution-workspace/institution-service";
import { RecruiterVerificationPanel } from "@/app/recruiter-dashboard/recruiter-verification-panel";

// Minimal-proof recruiter dashboard. Hosts the second-role banner and the recruiter trust
// verification panel (submit / pending / rejected / Trusted).
export default async function RecruiterDashboardPage() {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/recruiter-dashboard");
  }

  const unverified = await getUnverifiedRoles(session.user.id);

  // DEC-0060 — access to role-scoped surfaces is derived per-request from verification state.
  // A candidate-only account direct-URL'ing here must not reach the dashboard body (including
  // the elevated-tier section); redirect to the recruiter verification entry point.
  if (unverified.includes("recruiter")) {
    redirect("/auth/verify-role?as=recruiter");
  }

  const showCandidateBanner = unverified.includes("candidate");
  const recruiterIsVerified = !unverified.includes("recruiter");

  const [tierState, latestVerification, institutions, personalInstitution] = await Promise.all([
    getRecruiterTierForAccount(session.user.id),
    getLatestRecruiterVerificationForUser(session.user.id),
    listUserInstitutionMemberships(session.user.id),
    findOwnedPersonalInstitution(session.user.id),
  ]);
  const isTrusted = tierState?.recruiterVerificationTier === "elevated";
  // Only one personal institution is allowed per account, so the create-personal entry point is
  // shown only while the account has none.
  const canCreatePersonalInstitution = personalInstitution === null;

  return (
    <main className="page-shell app-page recruiter-dashboard">
      <PageHeader
        eyebrow="Ruang penyelenggara"
        title="Dasbor rekruter"
        description="Kelola identitas penyelenggara dan masuk ke workspace institusi Anda."
      />

      {showCandidateBanner ? (
        <SecondRoleBanner unverifiedRole="candidate" userId={session.user.id} />
      ) : null}

      <section className="hub-grid" aria-label="Akses rekruter">
        <Link className="hub-card hub-card--action" href="/institution/create">
          <span className="hub-card-icon">
            <Icon name="building" size="lg" />
          </span>
          <div className="stack-xs">
            <h2>Buat institusi</h2>
            <p>Buat ruang penyelenggara baru untuk memublikasikan kompetisi.</p>
          </div>
        </Link>
        <Link className="hub-card" href="/profile">
          <span className="hub-card-icon">
            <Icon name="user" size="lg" />
          </span>
          <div className="stack-xs">
            <h2>Profil saya</h2>
            <p>Pastikan identitas publik dan kredensial rekruter tetap mutakhir.</p>
          </div>
        </Link>
        {canCreatePersonalInstitution ? (
          <Link className="hub-card" href="/institution/personal">
            <span className="hub-card-icon">
              <Icon name="plus" size="lg" />
            </span>
            <div className="stack-xs">
              <h2>Buat institusi personal</h2>
              <p>
                Tampil sebagai perorangan untuk mulai memublikasikan kompetisi tanpa institusi
                resmi.
              </p>
            </div>
          </Link>
        ) : null}
      </section>

      <section className="content-section" aria-label="Institusi Anda">
        <h2>Institusi Anda</h2>
        {institutions.length > 0 ? (
          <ul className="record-list">
            {institutions.map((institution) => (
              <li className="record-row" key={institution.institutionId}>
                <div className="record-row-main">
                  <Link className="record-row-title" href={`/institution/${institution.slug}`}>
                    {institution.displayName}
                  </Link>
                  <p className="record-meta">{institution.description ?? "Belum ada deskripsi."}</p>
                  <span className="record-meta">
                    {institution.isOwner ? "Pemilik" : "Staf"} · {institution.staffCount} anggota
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p>Anda belum tergabung dalam institusi mana pun.</p>
        )}
      </section>

      {recruiterIsVerified ? (
        <RecruiterVerificationPanel
          userId={session.user.id}
          isTrusted={isTrusted}
          submission={
            latestVerification
              ? {
                  id: latestVerification.submission.id,
                  status: latestVerification.submission.status,
                  rejectionReason: latestVerification.submission.rejectionReason,
                  corporateEmail: latestVerification.submission.corporateEmail,
                  vouchedAt: latestVerification.submission.vouchedAt
                    ? latestVerification.submission.vouchedAt.toISOString()
                    : null,
                }
              : null
          }
          documents={
            latestVerification?.documents.map((d) => ({
              id: d.id,
              originalFileName: d.originalFileName,
            })) ?? []
          }
        />
      ) : null}
    </main>
  );
}
