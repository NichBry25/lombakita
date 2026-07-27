import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon, PageHeader } from "@/components/ui";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { requireRolePage } from "@/server/auth/page-guard";
import { loadInstitutionTypeBySlug } from "@/server/institution-workspace/institution-service";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";

type InstitutionHubPageProps = {
  params: Promise<{ institutionSlug: string }>;
};

export default async function InstitutionHubPage({ params }: InstitutionHubPageProps) {
  const { institutionSlug } = await params;
  const base = `/institution/${institutionSlug}`;
  const session = await requireRolePage("recruiter", { callbackPath: base });

  const isMember = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isMember) {
    redirect("/recruiter-dashboard");
  }

  // The /verification route serves the type upgrade for a personal institution and document
  // verification for a full one, so its entry in this hub is labelled for whichever it will render.
  const isPersonal = isPersonalInstitutionType(await loadInstitutionTypeBySlug(institutionSlug));

  const links = [
    {
      href: `${base}/competitions`,
      label: "Kompetisi",
      description: "Buat, terbitkan, dan tinjau partisipasi kompetisi.",
      icon: "trophy" as const,
    },
    {
      href: `${base}/members`,
      label: "Anggota",
      description: "Kelola akses staf dan anggota workspace.",
      icon: "users" as const,
    },
    {
      href: `${base}/settings`,
      label: "Pengaturan",
      description: "Perbarui identitas dan konfigurasi institusi.",
      icon: "building" as const,
    },
    isPersonal
      ? {
          href: `${base}/verification`,
          label: "Tingkatkan level institusi",
          description: "Ubah institusi personal menjadi institusi resmi. Bersifat permanen.",
          icon: "building" as const,
        }
      : {
          href: `${base}/verification`,
          label: "Verifikasi dokumen",
          description: "Ajukan bukti resmi dan pantau status tinjauan.",
          icon: "check" as const,
        },
    {
      href: `${base}/audit-log`,
      label: "Log audit",
      description: "Telusuri perubahan penting dalam urutan waktu.",
      icon: "inbox" as const,
    },
  ];

  return (
    <main className="page-shell app-page institution-hub-page">
      <PageHeader
        eyebrow="Panel institusi"
        title={institutionSlug}
        description="Kelola profil institusi, kompetisi, dan anggota."
        backHref="/recruiter-dashboard"
        backLabel="Dasbor"
      />
      <nav aria-label="Fitur institusi">
        <ul className="hub-grid institution-hub-grid">
          {links.map(({ href, label, description, icon }) => (
            <li key={href}>
              <Link href={href} className="hub-card">
                <span className="hub-card-icon">
                  <Icon name={icon} size="lg" />
                </span>
                <div className="stack-xs">
                  <h2>{label}</h2>
                  <p>{description}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}
