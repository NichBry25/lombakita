"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { IconButton } from "@/components/ui";
import { useHeaderMenu } from "@/components/navigation/use-header-menu";

const MENU_PANEL_ID = "header-account-menu-panel";
const ACCOUNT_ROW_COUNT = 2;

type HeaderAccountMenuProps = {
  pathname: string;
};

// The one account control of a signed-in header. "Keluar" signs out at once and goes to the
// landing page, with no confirmation.
export function HeaderAccountMenu({ pathname }: HeaderAccountMenuProps) {
  const {
    open,
    setOpen,
    setActiveIndex,
    rootRef,
    menuRef,
    toggleMenu,
    onTriggerKeyDown,
    onMenuKeyDown,
  } = useHeaderMenu(ACCOUNT_ROW_COUNT);
  const isOnProfile = pathname.startsWith("/profile");

  return (
    <div className="header-account-menu-root" ref={rootRef}>
      <IconButton
        icon="user"
        label="Akun"
        variant="plain"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={MENU_PANEL_ID}
        aria-current={isOnProfile ? "page" : undefined}
        onClick={toggleMenu}
        onKeyDown={onTriggerKeyDown}
      />
      {open ? (
        <div
          id={MENU_PANEL_ID}
          className="header-dashboard-panel header-account-panel"
          role="menu"
          aria-label="Akun"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          <Link
            href="/profile"
            role="menuitem"
            tabIndex={-1}
            className="header-dashboard-menuitem"
            onClick={() => setOpen(false)}
            onFocus={() => setActiveIndex(0)}
          >
            Profil
          </Link>
          <div className="header-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="header-dashboard-menuitem"
            onFocus={() => setActiveIndex(1)}
            onClick={() => void signOut({ callbackUrl: "/" })}
          >
            Keluar
          </button>
        </div>
      ) : null}
    </div>
  );
}
