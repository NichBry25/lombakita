"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { isSelfServiceRole } from "@/lib/access/roles";
import { Icon, type IconName } from "@/components/ui";

type Tab = {
  href: string;
  label: string;
  icon: IconName;
  isCurrent: (pathname: string) => boolean;
};

const HOME_TAB: Tab = { href: "/", label: "Beranda", icon: "home", isCurrent: (p) => p === "/" };
const EXPLORE_TAB: Tab = {
  href: "/competitions",
  label: "Jelajahi",
  icon: "search",
  isCurrent: (p) => p.startsWith("/competitions"),
};
const SAVED_TAB: Tab = {
  href: "/saved",
  label: "Tersimpan",
  icon: "bookmark",
  isCurrent: (p) => p.startsWith("/saved"),
};
const ACCOUNT_TAB: Tab = {
  href: "/profile",
  label: "Akun",
  icon: "user",
  isCurrent: (p) => p.startsWith("/profile"),
};
const SIGN_IN_TAB: Tab = {
  href: "/auth/login",
  label: "Masuk",
  icon: "user",
  isCurrent: (p) => p.startsWith("/auth"),
};

// Sign-in steps and the organiser and operations workspaces are tasks with their own way out, not
// places to browse from, and their long forms need the bottom of the screen.
const TASK_PATH_PREFIXES = ["/auth", "/admin", "/finance", "/institution"] as const;

// The phone's primary navigation, pinned where a thumb rests, the way installed apps put it. The
// header's menu stays for everything else; these are the four places a participant returns to.
// Hidden above the mobile breakpoint by CSS, where the header carries the same links.
export function MobileTabBar() {
  const pathname = usePathname();
  const { data: session, status } = useSession();

  if (TASK_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;

  // An operational account has no participant surfaces (see ApplicationHeader), so it gets no bar.
  const isAuthenticated = status === "authenticated";
  if (isAuthenticated && !isSelfServiceRole(session?.user?.role)) return null;

  const tabs = [HOME_TAB, EXPLORE_TAB, SAVED_TAB, isAuthenticated ? ACCOUNT_TAB : SIGN_IN_TAB];

  return (
    <nav className="mobile-tab-bar glass-chrome" aria-label="Navigasi bawah">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className="mobile-tab"
          aria-current={tab.isCurrent(pathname) ? "page" : undefined}
        >
          <Icon name={tab.icon} size="md" />
          <span>{tab.label}</span>
        </Link>
      ))}
    </nav>
  );
}
