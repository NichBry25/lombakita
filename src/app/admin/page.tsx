import Link from "next/link";
import { Icon, PageHeader } from "@/components/ui";

const ADMIN_LINKS = [
  {
    href: "/admin/institutions",
    label: "Verifikasi institusi",
    description: "Kelola status dan riwayat verifikasi institusi.",
    icon: "building" as const,
  },
  {
    href: "/admin/moderation",
    label: "Moderasi",
    description: "Cari akun atau institusi dan tangani dukungan internal.",
    icon: "users" as const,
  },
  {
    href: "/admin/verification",
    label: "Dokumen verifikasi",
    description: "Tinjau berkas identitas dalam antrean keputusan.",
    icon: "check" as const,
  },
  {
    href: "/admin/recruiter-verification",
    label: "Verifikasi rekruter",
    description: "Tinjau permohonan Rekruter Terpercaya dalam antrean prioritas.",
    icon: "user" as const,
  },
  {
    href: "/admin/featured",
    label: "Kompetisi unggulan",
    description: "Kurasi urutan kompetisi yang ditonjolkan ke publik.",
    icon: "trophy" as const,
  },
  {
    href: "/admin/payments",
    label: "Pembayaran tertahan",
    description: "Batalkan bukti transfer atau kompetisi yang tertahan pembayaran berjalan.",
    // No money glyph exists in the canonical set and inventing one is a defect, so the icon says
    // what the queue IS — an exception state waiting on an operator — rather than what it is about.
    icon: "alert-triangle" as const,
  },
  {
    href: "/admin/fee-rules",
    label: "Aturan biaya platform",
    description: "Tetapkan tarif komisi yang berlaku sejak tanggal tertentu.",
    icon: "settings" as const,
  },
];

export default function AdminHubPage() {
  return (
    <main className="page-shell app-page admin-page">
      <PageHeader
        title="Panel Platform Operations"
        description="Kelola verifikasi, moderasi, dan kompetisi unggulan."
      />
      <nav>
        <ul className="hub-grid admin-hub-grid">
          {ADMIN_LINKS.map(({ href, label, description, icon }) => (
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
