import Link from "next/link";
import { redirect } from "next/navigation";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { getCurrentSession } from "@/server/auth/session";

type InstitutionHubPageProps = {
  params: Promise<{ institutionSlug: string }>;
};

export default async function InstitutionHubPage({ params }: InstitutionHubPageProps) {
  const session = await getCurrentSession();
  const { institutionSlug } = await params;
  const base = `/institution/${institutionSlug}`;

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(base)}`);
  }

  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/");
  }

  const isMember = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isMember) {
    redirect("/recruiter-dashboard");
  }

  const links = [
    { href: `${base}/competitions`, label: "Kompetisi" },
    { href: `${base}/members`, label: "Anggota" },
    { href: `${base}/settings`, label: "Pengaturan" },
    { href: `${base}/verification`, label: "Verifikasi Dokumen" },
    { href: `${base}/audit-log`, label: "Log Audit" },
  ];

  return (
    <div style={{ fontFamily: "Arial, sans-serif", maxWidth: 600, margin: "48px auto", padding: "0 16px", color: "#0f1012" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>{institutionSlug}</h1>
      <p style={{ color: "#555", fontSize: 14, marginBottom: 24 }}>Panel Institusi</p>
      <nav>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {links.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                style={{
                  display: "block",
                  padding: "12px 16px",
                  background: "#f2f7fb",
                  borderRadius: 8,
                  color: "#355795",
                  textDecoration: "none",
                  fontWeight: 500,
                  fontSize: 14,
                }}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
