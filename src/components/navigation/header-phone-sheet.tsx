"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import type { RefObject } from "react";
import { ButtonLink } from "@/components/ui";
import {
  HEADER_DASHBOARD_ROWS,
  isOnDashboardRow,
  resolveDashboardRowTarget,
  type HeaderProfiles,
} from "@/components/navigation/header-dashboards";

type SignedInKind = "participant" | "platform_ops" | "other_operational";

type HeaderPhoneSheetProps = {
  isOpen: boolean;
  sheetRef: RefObject<HTMLElement | null>;
  pathname: string;
  closeSheet: (options: { returnFocus: boolean }) => void;
  isOnCompetitions: boolean;
  signedIn: SignedInKind | null;
  showsSignInButton: boolean;
  signInHref: string;
  profiles: HeaderProfiles;
};

// The phone navigation: a sheet that hangs from the bar over a scrim, in groups of where to go,
// the dashboards and the account. The scrim is a plain element because the sheet closes on any tap
// outside it, and Escape and the toggle are handled by the caller's hook.
export function HeaderPhoneSheet({
  isOpen,
  sheetRef,
  pathname,
  closeSheet,
  isOnCompetitions,
  signedIn,
  showsSignInButton,
  signInHref,
  profiles,
}: HeaderPhoneSheetProps) {
  const dataOpen = isOpen ? "true" : "false";
  const closeAfterLink = () => closeSheet({ returnFocus: true });

  return (
    <>
      <div
        className="header-sheet-scrim"
        data-open={dataOpen}
        aria-hidden="true"
        onClick={closeAfterLink}
      />
      <nav
        id="mobile-navigation"
        ref={sheetRef}
        className="header-sheet"
        data-open={dataOpen}
        aria-label="Navigasi seluler"
      >
        <div className="header-sheet-group">
          <Link
            href="/competitions"
            className="header-sheet-row"
            aria-current={isOnCompetitions ? "page" : undefined}
            onClick={closeAfterLink}
          >
            Jelajahi
          </Link>
        </div>
        {signedIn === null && showsSignInButton ? (
          <div className="header-sheet-group">
            <ButtonLink
              href={signInHref}
              variant="outline"
              size="md"
              fullWidth
              className="header-sheet-sign-in"
              onClick={closeAfterLink}
            >
              Masuk
            </ButtonLink>
          </div>
        ) : null}
        {signedIn === "participant" ? (
          <div className="header-sheet-group">
            {HEADER_DASHBOARD_ROWS.map((row) => {
              const target = resolveDashboardRowTarget(row, profiles);
              const isCurrent = !target.needsActivation && isOnDashboardRow(pathname, row);
              return (
                <Link
                  key={row.key}
                  href={target.href}
                  className="header-sheet-row"
                  aria-current={isCurrent ? "page" : undefined}
                  onClick={closeAfterLink}
                >
                  {row.sheetLabel}
                  {target.needsActivation ? (
                    <span className="header-menu-status">Aktifkan</span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ) : null}
        {signedIn === "platform_ops" ? (
          <div className="header-sheet-group">
            <Link
              href="/admin"
              className="header-sheet-row"
              aria-current={pathname.startsWith("/admin") ? "page" : undefined}
              onClick={closeAfterLink}
            >
              Platform Operations
            </Link>
          </div>
        ) : null}
        {signedIn !== null ? (
          <div className="header-sheet-group">
            <Link
              href="/profile"
              className="header-sheet-row"
              aria-current={pathname.startsWith("/profile") ? "page" : undefined}
              onClick={closeAfterLink}
            >
              Profil
            </Link>
            <button
              type="button"
              className="header-sheet-row"
              onClick={() => {
                closeSheet({ returnFocus: false });
                void signOut({ callbackUrl: "/" });
              }}
            >
              Keluar
            </button>
          </div>
        ) : null}
      </nav>
    </>
  );
}
