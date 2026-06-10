import Link from "next/link";

const ADMIN_LINKS = [
  { href: "/admin/institutions", label: "Verifikasi Institusi" },
  { href: "/admin/moderation", label: "Moderasi" },
  { href: "/admin/verification", label: "Dokumen Verifikasi" },
  { href: "/admin/featured", label: "Kompetisi Unggulan" },
];

export default function AdminHubPage() {
  return (
    <div style={{ fontFamily: "Arial, sans-serif", maxWidth: 600, margin: "48px auto", padding: "0 16px", color: "#0f1012" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Panel Platform Ops</h1>
      <p style={{ color: "#555", fontSize: 14, marginBottom: 24 }}>Pilih area yang ingin dikelola.</p>
      <nav>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {ADMIN_LINKS.map(({ href, label }) => (
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
