import type { ReactNode } from "react";
import Link from "next/link";
import { requireRolePage } from "@/server/auth/page-guard";

const PAGE_PATH = "/admin/institutions";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireRolePage("platform_ops", { callbackPath: PAGE_PATH });

  return (
    <div className="admin-shell">
      <nav className="admin-nav glass-chrome" aria-label="Navigasi Platform Operations">
        <Link href="/admin" className="admin-nav-brand">
          Platform Operations
        </Link>
        <div className="admin-nav-links">
          <Link href="/admin/institutions">Institusi</Link>
          <Link href="/admin/verification">Dokumen</Link>
          <Link href="/admin/recruiter-verification">Rekruter</Link>
          <Link href="/admin/moderation">Moderasi</Link>
          <Link href="/admin/featured">Unggulan</Link>
        </div>
      </nav>
      {children}
    </div>
  );
}
