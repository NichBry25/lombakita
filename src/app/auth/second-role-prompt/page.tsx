import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import {
  dashboardPathForRole,
  getSoleVerifiedRole,
  getUnverifiedRoles,
  type VerifiableRole,
} from "@/server/auth/role-verification";
import { SkipForNowButton } from "./skip-button";

const ROLE_COPY: Record<VerifiableRole, { headline: string; description: string; cta: string }> = {
  candidate: {
    headline: "Verifikasi akun kandidat Anda",
    description:
      "Akun Anda baru terverifikasi sebagai rekruter. Verifikasi juga sebagai kandidat untuk dapat mengikuti kompetisi sebagai mahasiswa.",
    cta: "Verifikasi sebagai kandidat sekarang",
  },
  recruiter: {
    headline: "Verifikasi akun rekruter Anda",
    description:
      "Akun Anda baru terverifikasi sebagai kandidat. Verifikasi juga sebagai rekruter untuk dapat memposting peluang.",
    cta: "Verifikasi sebagai rekruter sekarang",
  },
};

// Step 4.0b — second-role verification interstitial. Server component decides whether to
// render the prompt or short-circuit to the dashboard. Renders the two-button screen when a
// single role is verified and the dismissal flag is unset.
export default async function SecondRolePromptPage() {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/auth/sign-in?callbackUrl=/auth/post-login");
  }

  const unverified = await getUnverifiedRoles(session.user.id);
  const verifiedRole = await getSoleVerifiedRole(session.user.id);

  // Multi-role or zero-role accounts should not reach this surface. If they navigate here
  // directly, route them through the standard post-login decision so they land on a dashboard.
  const unverifiedRole = unverified[0];
  if (unverified.length !== 1 || !verifiedRole || !unverifiedRole) {
    redirect("/auth/post-login");
  }

  const copy = ROLE_COPY[unverifiedRole];
  const dashboardPath = dashboardPathForRole(verifiedRole);

  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "3rem 1rem" }}>
      <h1 style={{ marginBottom: "0.75rem" }}>{copy.headline}</h1>
      <p style={{ color: "#555", marginBottom: "1.5rem" }}>{copy.description}</p>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <Link
          href={`/auth/verify-role?as=${unverifiedRole}`}
          data-testid={`verify-now-${unverifiedRole}`}
          style={{
            padding: "0.6rem 1.25rem",
            background: "#355795",
            color: "#fff",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: "0.95rem",
          }}
        >
          {copy.cta}
        </Link>

        <SkipForNowButton destinationOnSkip={dashboardPath} verifiedRole={verifiedRole} />
      </div>
    </main>
  );
}
