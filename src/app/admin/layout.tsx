import type { ReactNode } from "react";
import Link from "next/link";
import { requireRolePage } from "@/server/auth/page-guard";

// The return address for every page under /admin/*, because a layout cannot read the pathname of
// the page it is wrapping. The admin hub is the honest choice: it is reachable from any /admin/*
// deep link and is one click from each queue, whereas naming a specific queue here returns a
// visitor to a page they never asked for. Returning to the EXACT requested page needs the guard to
// move onto each page — the shape every other role-scoped surface already uses — which is the real
// close of this and is deliberately not done here.
const PAGE_PATH = "/admin";

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
          <Link href="/admin/fee-rules">Biaya</Link>
        </div>
      </nav>
      {children}
    </div>
  );
}
