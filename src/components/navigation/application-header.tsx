"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { NotificationBell } from "@/app/notification-bell";
import { ButtonLink, Icon } from "@/components/ui";
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
  const { status } = useSession();
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
          {status === "authenticated" ? <HeaderDashboardMenu pathname={pathname} /> : null}
        </nav>

        <div className="header-actions">
          <span className="locale-label" aria-label="Bahasa antarmuka Indonesia">
            ID
          </span>
          <Link
            href="/saved"
            className="ui-button icon-button"
            data-variant="ghost"
            data-size="md"
            aria-label="Kompetisi tersimpan"
          >
            <Icon name="bookmark" size="lg" />
          </Link>
          <NotificationBell />
          <button
            type="button"
            className="ui-button icon-button"
            data-variant="ghost"
            data-size="md"
            onClick={toggleTheme}
            aria-label={theme === "light" ? "Gunakan tema gelap" : "Gunakan tema terang"}
          >
            <Icon name={theme === "light" ? "moon" : "sun"} size="lg" />
          </button>
          {status === "loading" ? null : status === "authenticated" ? (
            <>
              <Link
                href="/profile"
                className="ui-button icon-button header-auth-action"
                data-variant="ghost"
                data-size="md"
                aria-label="Profil dan akun saya"
              >
                <Icon name="user" size="lg" />
              </Link>
              <button
                type="button"
                className="ui-button header-auth-action"
                data-variant="outline"
                data-size="sm"
                onClick={() => void signOut({ callbackUrl: "/" })}
              >
                Keluar
              </button>
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
          <button
            type="button"
            className="ui-button icon-button mobile-nav-toggle"
            data-variant="ghost"
            data-size="md"
            aria-label={menuOpen ? "Tutup menu" : "Buka menu"}
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            onClick={() => setMenuOpen((currentValue) => !currentValue)}
          >
            <Icon name={menuOpen ? "close" : "menu"} size="lg" />
          </button>
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
        <Link href="/saved" className="header-nav-link" onClick={() => setMenuOpen(false)}>
          Tersimpan
        </Link>
        {status === "loading" ? null : status === "authenticated" ? (
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
