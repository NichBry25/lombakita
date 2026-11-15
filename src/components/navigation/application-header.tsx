"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { isSelfServiceRole, sessionHasRole } from "@/lib/access/roles";
import { sameSitePathOr } from "@/lib/session/return-path";
import { NotificationBell } from "@/app/notification-bell";
import { IconButton, IconButtonLink, LinkPendingSlot } from "@/components/ui";
import { HeaderDashboardMenu } from "@/components/navigation/header-dashboard-menu";
import { HeaderIdentity } from "@/components/navigation/header-identity";
import { HeaderPhoneSheet } from "@/components/navigation/header-phone-sheet";
import { PHONE_SHEET_TOGGLE_ID, usePhoneSheet } from "@/components/navigation/use-phone-sheet";

const HEADER_SCROLL_THRESHOLD_PX = 8;

type ThemeName = "light" | "dark";

function isOnCompetitionPages(pathname: string) {
  return pathname.startsWith("/competitions");
}

function resolveInitialTheme(): ThemeName {
  const savedTheme = window.localStorage.getItem("lombakita-theme");
  if (savedTheme === "light" || savedTheme === "dark") return savedTheme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ApplicationHeader() {
  const pathname = usePathname();
  const returnPath = sameSitePathOr(pathname, "");
  const keepsReturnPath = returnPath !== "" && !returnPath.startsWith("/auth/");
  const onSignInForm = returnPath === "/auth/login" || returnPath === "/auth/register";
  const signInHref = keepsReturnPath
    ? `/auth/login?callbackUrl=${encodeURIComponent(returnPath)}`
    : "/auth/login";
  const { data: session, status } = useSession();
  const [theme, setTheme] = useState<ThemeName>("light");
  const [scrolled, setScrolled] = useState(false);
  const phoneSheet = usePhoneSheet(pathname);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const initialTheme = resolveInitialTheme();
      document.documentElement.dataset.theme = initialTheme;
      setTheme(initialTheme);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    const updateScrolledState = () => {
      setScrolled(window.scrollY > HEADER_SCROLL_THRESHOLD_PX);
    };

    updateScrolledState();
    window.addEventListener("scroll", updateScrolledState, { passive: true });
    return () => window.removeEventListener("scroll", updateScrolledState);
  }, []);

  // An operational account cannot act on any participant surface, so the participant entry points
  // are withheld rather than shown and then refused. Its own workspace is offered instead. Signed-
  // out visitors keep every participant entry point — those lead to sign-in, which is the point.
  const isAuthenticated = status === "authenticated";
  const role = session?.user?.role;
  const isOperationalAccount = isAuthenticated && !isSelfServiceRole(role);
  const showsParticipantNavigation = isAuthenticated && !isOperationalAccount;
  const showsPlatformOpsNavigation = role === "platform_ops";
  const verifiedRoles = session?.user?.verifiedRoles;
  const profiles = {
    candidate: sessionHasRole(role, verifiedRoles, "candidate"),
    recruiter: sessionHasRole(role, verifiedRoles, "recruiter"),
  };
  const isCompetitionsCurrent = isOnCompetitionPages(pathname);

  function resolveSignedInKind() {
    if (!isAuthenticated) return null;
    if (showsParticipantNavigation) return "participant";
    if (showsPlatformOpsNavigation) return "platform_ops";
    return "other_operational";
  }

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("lombakita-theme", nextTheme);
    setTheme(nextTheme);
  }

  return (
    <header className="site-header" data-scrolled={scrolled ? "true" : "false"}>
      <div className="header-inner">
        {/* The landing page is the slowest indexable route to first byte and has no `loading.tsx`
            — an indexable route cannot have one — so the wordmark acknowledges its own click here
            (§14). The slot renders nothing until the navigation is in flight. */}
        <Link href="/" className="brand-lockup" aria-label="Lombakita, beranda">
          <span className="brand-wordmark brand-wordmark-primary" aria-hidden="true" />
          <span className="brand-wordmark brand-wordmark-reversed" aria-hidden="true" />
          <LinkPendingSlot />
        </Link>

        <nav className="desktop-nav" aria-label="Navigasi utama">
          <Link
            href="/competitions"
            className="header-nav-link"
            aria-current={isCompetitionsCurrent ? "page" : undefined}
          >
            <span className="header-nav-label" data-label="Jelajahi">
              Jelajahi
            </span>
          </Link>
          {showsParticipantNavigation ? (
            <HeaderDashboardMenu pathname={pathname} profiles={profiles} />
          ) : null}
          {showsPlatformOpsNavigation ? (
            <Link
              href="/admin"
              className="header-nav-link"
              aria-current={pathname.startsWith("/admin") ? "page" : undefined}
            >
              <span className="header-nav-label" data-label="Platform Operations">
                Platform Operations
              </span>
            </Link>
          ) : null}
        </nav>

        <div className="header-actions">
          {isOperationalAccount ? null : (
            <IconButtonLink
              href="/saved"
              icon="bookmark"
              label="Kompetisi tersimpan"
              variant="plain"
            />
          )}
          {isAuthenticated ? (
            <NotificationBell isCurrentPage={pathname.startsWith("/inbox")} />
          ) : null}
          <IconButton
            icon="moon"
            label="Tema gelap"
            tooltip={theme === "dark" ? "Matikan tema gelap" : "Aktifkan tema gelap"}
            variant="plain"
            className="theme-toggle"
            aria-pressed={theme === "dark"}
            onClick={toggleTheme}
          />
          <HeaderIdentity
            sessionStatus={status}
            pathname={pathname}
            signInHref={signInHref}
            onSignInForm={onSignInForm}
          />
          <IconButton
            id={PHONE_SHEET_TOGGLE_ID}
            icon={phoneSheet.isOpen ? "close" : "menu"}
            label={phoneSheet.isOpen ? "Tutup menu" : "Buka menu"}
            variant="plain"
            className="mobile-nav-toggle"
            aria-expanded={phoneSheet.isOpen}
            aria-controls="mobile-navigation"
            onClick={phoneSheet.toggleSheet}
          />
        </div>
      </div>

      <HeaderPhoneSheet
        isOpen={phoneSheet.isOpen}
        sheetRef={phoneSheet.sheetRef}
        pathname={pathname}
        closeSheet={phoneSheet.closeSheet}
        isOnCompetitions={isCompetitionsCurrent}
        signedIn={resolveSignedInKind()}
        showsSignInButton={status !== "loading" && !onSignInForm}
        signInHref={signInHref}
        profiles={profiles}
      />
    </header>
  );
}
