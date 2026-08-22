import type { ReactNode } from "react";
import Link from "next/link";
import { requireRolePage } from "@/server/auth/page-guard";

// The return address for every page under /finance/*, for the same reason /admin/layout.tsx carries
// one: a layout cannot read the pathname of the page it wraps.
//
// A SEPARATE SHELL FROM /admin, not a shared one with a widened guard. `requireRolePage` takes one
// role, and widening the admin layout to admit finance_ops would put a role with NO verdict power
// inside the shell whose whole purpose is exercising it, one forgotten page-level check away from
// finance_ops reaching the DEC-0132 hatch. Two shells, two roles, no overlap.
const PAGE_PATH = "/finance";

export default async function FinanceLayout({ children }: { children: ReactNode }) {
  // finance_ops is not a self-service role, so this call also applies the operational MFA challenge
  // by construction, the same choke point every /admin page sits behind.
  await requireRolePage("finance_ops", { callbackPath: PAGE_PATH });

  return (
    <div className="admin-shell">
      <nav className="admin-nav glass-chrome" aria-label="Navigasi Finance Operations">
        <Link href="/finance" className="admin-nav-brand">
          Finance Operations
        </Link>
        <div className="admin-nav-links">
          <Link href="/finance/payments">Sengketa pembayaran</Link>
        </div>
      </nav>
      {children}
    </div>
  );
}
