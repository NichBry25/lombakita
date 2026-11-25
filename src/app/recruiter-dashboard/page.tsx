import Link from "next/link";
import { SecondRoleBanner } from "@/components/auth/second-role-banner";
import { HostStatusCard } from "@/components/host/host-status-card";
import { Icon, PageHeader } from "@/components/ui";
import { requireRolePage } from "@/server/auth/page-guard";
import { getUnverifiedRoles } from "@/server/auth/role-verification";
import { readHostStatusForAccount } from "@/server/host-trust/host-check-service";
import { listUserInstitutionMemberships } from "@/server/institution-workspace/institution-service";

export default async function RecruiterDashboardPage() {
  const session = await requireRolePage("recruiter", {
    callbackPath: "/recruiter-dashboard",
    missingRoleRedirect: "/auth/verify-role?as=recruiter",
  });

  // Onboarding state, not authorization: drives whether the second-role banner is offered.
  // requireRolePage already guarantees this session can act as recruiter, so there is no
  // "unverified recruiter" branch to render here — only the candidate side can still be unverified.
  const unverified = await getUnverifiedRoles(session.user.id);
  const showCandidateBanner = unverified.includes("candidate");

  const [hostStatus, institutions] = await Promise.all([
    readHostStatusForAccount(session.user.id),
    listUserInstitutionMemberships(session.user.id),
  ]);

  return (
    <main className="page-shell app-page recruiter-dashboard">
      <PageHeader
        title="Dasbor penyelenggara"
        description="Kelola identitas penyelenggara dan buka ruang kerja institusi Anda."
      />

      {showCandidateBanner ? (
        <SecondRoleBanner unverifiedRole="candidate" userId={session.user.id} />
      ) : null}

      <section className="hub-grid" aria-label="Akses penyelenggara">
        <Link className="hub-card hub-card--action" href="/institution/create">
          <span className="hub-card-icon">
            <Icon name="plus" size="lg" />
          </span>
          <div className="stack-xs">
            <h2>Buat institusi</h2>
            <p>
              Buat ruang penyelenggara baru, pribadi atau organisasi. Satu akun dapat memiliki
              hingga 3 institusi.
            </p>
          </div>
        </Link>
        <Link className="hub-card" href="/profile">
          <span className="hub-card-icon">
            <Icon name="user" size="lg" />
          </span>
          <div className="stack-xs">
            <h2>Profil saya</h2>
            <p>Pastikan identitas publik dan kredensial penyelenggara tetap mutakhir.</p>
          </div>
        </Link>
      </section>

      <section className="content-section" aria-label="Institusi Anda">
        <h2>Institusi Anda</h2>
        {institutions.length > 0 ? (
          <ul className="institution-card-grid">
            {institutions.map((institution) => (
              <li className="institution-card" key={institution.institutionId}>
                {/* Purely the organizer's own imagery — the card names the institution in text, so
                    neither the banner nor the logo carries anything for assistive technology. */}
                <span
                  className={`institution-card-banner${
                    institution.bannerUrl ? " institution-card-banner-uploaded" : ""
                  }`}
                  aria-hidden="true"
                >
                  {institution.bannerUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={institution.bannerUrl}
                      alt=""
                      className="institution-card-banner-image"
                    />
                  ) : null}
                </span>
                <div className="institution-card-body">
                  <span className="institution-card-logo" aria-hidden="true">
                    {institution.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={institution.logoUrl} alt="" />
                    ) : (
                      <Icon name="building" size="lg" />
                    )}
                  </span>
                  <Link className="record-row-title" href={`/institution/${institution.slug}`}>
                    {institution.displayName}
                  </Link>
                  {/* The public organizer bio is the authored field; `description` survives only as
                      the fallback for institutions that carry no organizer profile. */}
                  <p className="record-meta">
                    {institution.about ?? institution.description ?? "Belum ada deskripsi."}
                  </p>
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

      <HostStatusCard expectedUserId={session.user.id} status={hostStatus} />
    </main>
  );
}
