"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { isSelfServiceRole } from "@/lib/access/roles";
import { NotificationBell } from "@/app/notification-bell";
import { ButtonLink, IconButton, IconButtonLink } from "@/components/ui";
import { HeaderDashboardMenu } from "@/components/navigation/header-dashboard-menu";

const HEADER_SCROLL_THRESHOLD_PX = 8;

const PRIMARY_NAVIGATION = [
  { href: "/competitions", label: "Jelajahi" },
  { href: "/#tentang", label: "Tentang" },
] as const;

type ThemeName = "light" | "dark";

function isCurrentNavigationItem(pathname: string, href: string) {
  if (href === "/competitions") return pathname.startsWith("/competitions");
  return false;
}

function resolveInitialTheme(): ThemeName {
  const savedTheme = window.localStorage.getItem("lombakita-theme");
  if (savedTheme === "light" || savedTheme === "dark") return savedTheme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ApplicationHeader() {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const [theme, setTheme] = useState<ThemeName>("light");
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

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
  const isOperationalAccount = isAuthenticated && !isSelfServiceRole(session?.user?.role);
  const showsParticipantNavigation = isAuthenticated && !isOperationalAccount;
  const showsPlatformOpsNavigation = session?.user?.role === "platform_ops";

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("lombakita-theme", nextTheme);
    setTheme(nextTheme);
  }

  return (
    <header className="site-header" data-scrolled={scrolled ? "true" : "false"}>
      <div className="header-inner">
        <Link href="/" className="brand-lockup" aria-label="Lombakita.id, beranda">
          <span className="brand-wordmark brand-wordmark-primary" aria-hidden="true" />
          <span className="brand-wordmark brand-wordmark-reversed" aria-hidden="true" />
        </Link>

        <nav className="desktop-nav" aria-label="Navigasi utama">
          {PRIMARY_NAVIGATION.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="header-nav-link"
              aria-current={isCurrentNavigationItem(pathname, item.href) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
          {showsParticipantNavigation ? <HeaderDashboardMenu pathname={pathname} /> : null}
          {showsPlatformOpsNavigation ? (
            <Link
              href="/admin"
              className="header-nav-link"
              aria-current={pathname.startsWith("/admin") ? "page" : undefined}
            >
              Platform Operations
            </Link>
          ) : null}
        </nav>

        <div className="header-actions">
          <span className="locale-label" aria-label="Bahasa antarmuka Indonesia">
            ID
          </span>
          {isOperationalAccount ? null : (
            <IconButtonLink
              href="/saved"
              icon="bookmark"
              label="Kompetisi tersimpan"
              variant="ghost"
            />
          )}
          <NotificationBell />
          <IconButton
            icon={theme === "light" ? "moon" : "sun"}
            label={theme === "light" ? "Gunakan tema gelap" : "Gunakan tema terang"}
            variant="ghost"
            onClick={toggleTheme}
          />
          {status === "loading" ? null : status === "authenticated" ? (
            <>
              <IconButtonLink
                href="/profile"
                icon="user"
                label="Profil dan akun saya"
                variant="ghost"
                className="header-auth-action"
              />
              <IconButton
                icon="logout"
                label="Keluar"
                variant="outline"
                className="header-auth-action"
                onClick={() => void signOut({ callbackUrl: "/" })}
              />
            </>
          ) : (
            <>
              <ButtonLink
                href="/auth/login"
                variant="ghost"
                size="sm"
                className="header-auth-action"
              >
                Masuk
              </ButtonLink>
              <ButtonLink
                href="/auth/register"
                variant="primary"
                size="sm"
                className="header-auth-action"
              >
                Daftar
              </ButtonLink>
            </>
          )}
          <IconButton
            icon={menuOpen ? "close" : "menu"}
            label={menuOpen ? "Tutup menu" : "Buka menu"}
            variant="ghost"
            className="mobile-nav-toggle"
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            onClick={() => setMenuOpen((currentValue) => !currentValue)}
          />
        </div>
      </div>

      <nav
        id="mobile-navigation"
        className="mobile-nav"
        data-open={menuOpen ? "true" : "false"}
        aria-label="Navigasi seluler"
      >
        {PRIMARY_NAVIGATION.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="header-nav-link"
            aria-current={isCurrentNavigationItem(pathname, item.href) ? "page" : undefined}
            onClick={() => setMenuOpen(false)}
          >
            {item.label}
          </Link>
        ))}
        {isOperationalAccount ? null : (
          <Link href="/saved" className="header-nav-link" onClick={() => setMenuOpen(false)}>
            Tersimpan
          </Link>
        )}
        {status === "loading" ? null : status === "authenticated" ? (
          <>
            {showsParticipantNavigation ? (
              <>
                <Link
                  href="/candidate-dashboard"
                  className="header-nav-link"
                  aria-current={pathname.startsWith("/candidate-dashboard") ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                >
                  Dasbor kandidat
                </Link>
                <Link
                  href="/recruiter-dashboard"
                  className="header-nav-link"
                  aria-current={pathname.startsWith("/recruiter-dashboard") ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                >
                  Dasbor rekruter
                </Link>
              </>
            ) : null}
            {showsPlatformOpsNavigation ? (
              <Link
                href="/admin"
                className="header-nav-link"
                aria-current={pathname.startsWith("/admin") ? "page" : undefined}
                onClick={() => setMenuOpen(false)}
              >
                Platform Operations
              </Link>
            ) : null}
            <Link href="/profile" className="header-nav-link" onClick={() => setMenuOpen(false)}>
              Profil saya
            </Link>
            <button
              type="button"
              className="header-nav-link"
              onClick={() => {
                setMenuOpen(false);
                void signOut({ callbackUrl: "/" });
              }}
            >
              Keluar
            </button>
          </>
        ) : (
          <>
            <Link href="/auth/login" className="header-nav-link" onClick={() => setMenuOpen(false)}>
              Masuk
            </Link>
            <Link
              href="/auth/register"
              className="header-nav-link"
              onClick={() => setMenuOpen(false)}
            >
              Daftar akun
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
