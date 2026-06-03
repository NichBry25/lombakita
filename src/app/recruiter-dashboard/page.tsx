import Link from "next/link";
import { redirect } from "next/navigation";
import { SecondRoleBanner } from "@/components/auth/second-role-banner";
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
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ marginBottom: "1rem" }}>Dasbor Rekruter</h1>

      {showCandidateBanner ? (
        <SecondRoleBanner unverifiedRole="candidate" userId={session.user.id} />
      ) : null}

      <p style={{ color: "#555", marginBottom: "1.25rem" }}>
        Halaman ini adalah dasbor rekruter versi minimal. Konten dasbor akan ditambahkan pada
        tahap berikutnya.
      </p>

      <ul style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <li>
          <Link href="/institution/workspace">Ruang kerja institusi</Link>
        </li>
        <li>
          <Link href="/profile">Profil saya</Link>
        </li>
      </ul>

      {recruiterIsVerified ? (
        <section
          data-testid="elevated-tier-entry"
          style={{
            marginTop: "2rem",
            padding: "1rem",
            border: "1px dashed #c7d2fe",
            borderRadius: 6,
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: "1rem" }}>
            Verifikasi rekruter tingkat lanjut (stub)
          </h2>
          <p style={{ fontSize: "0.85rem", color: "#555" }}>
            Tingkat lanjut akan diaktifkan pada Phase 4.0c. Saat ini hanya tautan stub.
          </p>
          <Link
            href="/auth/verify-tier?target=elevated"
            style={{
              display: "inline-block",
              padding: "0.35rem 0.85rem",
              background: "#355795",
              color: "#fff",
              borderRadius: 6,
              textDecoration: "none",
              fontSize: "0.85rem",
            }}
          >
            Pelajari lebih lanjut
          </Link>
        </section>
      ) : null}
    </main>
  );
}
