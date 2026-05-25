import Link from "next/link";
import { redirect } from "next/navigation";
import { SecondRoleBanner } from "@/components/auth/second-role-banner";
import { getCurrentSession } from "@/server/auth/session";
import { getUnverifiedRoles } from "@/server/auth/role-verification";

// Step 4.0b — minimal-proof candidate dashboard scaffold. The page exists so the post-login
// flow has a verified-role landing surface and the second-role banner has a host. Real
// candidate dashboard content lands in a later phase.
export default async function CandidateDashboardPage() {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/sign-in?callbackUrl=/candidate-dashboard");
  }

  const unverified = await getUnverifiedRoles(session.user.id);

  // DEC-0060 — access to role-scoped surfaces is derived per-request from verification state.
  // A recruiter-only account direct-URL'ing here must not reach the dashboard body; redirect
  // to the candidate verification entry point so the user can opt into the second role mode.
  if (unverified.includes("candidate")) {
    redirect("/auth/verify-role?as=candidate");
  }

  const showRecruiterBanner = unverified.includes("recruiter");

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ marginBottom: "1rem" }}>Dasbor Kandidat</h1>

      {showRecruiterBanner ? (
        <SecondRoleBanner unverifiedRole="recruiter" userId={session.user.id} />
      ) : null}

      <p style={{ color: "#555", marginBottom: "1.25rem" }}>
        Halaman ini adalah dasbor kandidat versi minimal. Konten dasbor akan ditambahkan pada
        tahap berikutnya.
      </p>

      <ul style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <li>
          <Link href="/competitions">Jelajahi kompetisi</Link>
        </li>
        <li>
          <Link href="/saved">Kompetisi tersimpan</Link>
        </li>
        <li>
          <Link href="/profile">Profil saya</Link>
        </li>
      </ul>
    </main>
  );
}
