import Link from "next/link";
import { redirect } from "next/navigation";
import { SecondRoleBanner } from "@/components/auth/second-role-banner";
import { ButtonLink, Icon, PageHeader } from "@/components/ui";
import { getCurrentSession } from "@/server/auth/session";
import { getUnverifiedRoles } from "@/server/auth/role-verification";

// Step 4.0b — minimal-proof recruiter dashboard scaffold. Hosts the second-role banner and the
// elevated-tier (Phase 4.0c) entry point stub.
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
        <Link className="hub-card" href="/institution/workspace">
          <span className="hub-card-icon">
            <Icon name="building" size="lg" />
          </span>
          <div className="stack-xs">
            <h2>Workspace institusi</h2>
            <p>Buat ruang penyelenggara baru atau lanjutkan pengelolaan institusi.</p>
          </div>
          <span className="hub-card-arrow" aria-hidden="true">
            →
          </span>
        </Link>
        <Link className="hub-card" href="/profile">
          <span className="hub-card-icon">
            <Icon name="user" size="lg" />
          </span>
          <div className="stack-xs">
            <h2>Profil saya</h2>
            <p>Pastikan identitas publik dan kredensial rekruter tetap mutakhir.</p>
          </div>
          <span className="hub-card-arrow" aria-hidden="true">
            →
          </span>
        </Link>
      </section>

      {recruiterIsVerified ? (
        <section data-testid="elevated-tier-entry" className="content-section recruiter-tier-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Kredibilitas penyelenggara</p>
              <h2>Verifikasi rekruter tingkat lanjut</h2>
            </div>
            <span className="status-badge">Segera hadir</span>
          </div>
          <p className="muted-copy">
            Tingkat lanjut akan diaktifkan pada fase berikutnya. Saat ini tersedia sebagai pratinjau
            jalur verifikasi.
          </p>
          <ButtonLink href="/auth/verify-tier?target=elevated" variant="outline" size="sm">
            Pelajari lebih lanjut
          </ButtonLink>
        </section>
      ) : null}
    </main>
  );
}
