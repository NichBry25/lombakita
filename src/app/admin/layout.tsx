import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import Link from "next/link";
import { getCurrentSession } from "@/server/auth/session";

const PAGE_PATH = "/admin/institutions";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(PAGE_PATH)}`);
  }

  if (session.user.role !== "platform_ops") {
    redirect("/");
  }

  return (
    <div className="admin-shell">
      <nav className="admin-nav glass-chrome" aria-label="Navigasi Platform Ops">
        <Link href="/admin" className="admin-nav-brand">
          Platform Ops
        </Link>
        <div className="admin-nav-links">
          <Link href="/admin/institutions">Institusi</Link>
          <Link href="/admin/verification">Dokumen</Link>
          <Link href="/admin/moderation">Moderasi</Link>
          <Link href="/admin/featured">Unggulan</Link>
        </div>
      </nav>
      {children}
    </div>
  );
}
