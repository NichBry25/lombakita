"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui";

const DASHBOARD_LINKS = [
  { href: "/candidate-dashboard", label: "Kandidat" },
  { href: "/recruiter-dashboard", label: "Rekruter" },
] as const;

const MENU_PANEL_ID = "header-dashboard-menu-panel";

type HeaderDashboardMenuProps = {
  pathname: string;
};

// "Dasbor" nav dropdown — WAI-ARIA menu-button pattern (real navigation links, not a
// value-select control, so this uses menu/menuitem roles rather than FilterDropdown's
// listbox/option roles). Visibility is decided by the caller (ApplicationHeader only
// mounts this once authenticated); both dashboard destinations already guard server-side
// and redirect an unverified account to the role sign-up form, so no missing-role UI
// lives here.
export function HeaderDashboardMenu({ pathname }: HeaderDashboardMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isOnDashboard = DASHBOARD_LINKS.some((link) => pathname.startsWith(link.href));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Roving focus: move DOM focus to the active menu item as the user navigates with arrows.
  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']");
    items?.[activeIndex]?.focus();
  }, [open, activeIndex]);

  const openMenu = () => {
    setActiveIndex(0);
    setOpen(true);
  };

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu();
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        closeAndFocusTrigger();
        break;
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(DASHBOARD_LINKS.length - 1, index + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className="header-dashboard-menu-root" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="header-nav-link header-dashboard-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={MENU_PANEL_ID}
        aria-current={isOnDashboard ? "page" : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        Dasbor
        <Icon name="chevron-down" size="sm" className="header-dashboard-chevron" />
      </button>
      {open ? (
        <div
          id={MENU_PANEL_ID}
          className="header-dashboard-panel glass-focus"
          role="menu"
          aria-label="Dasbor"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {DASHBOARD_LINKS.map((link, index) => (
            <Link
              key={link.href}
              href={link.href}
              role="menuitem"
              tabIndex={-1}
              className="header-dashboard-menuitem"
              aria-current={pathname.startsWith(link.href) ? "page" : undefined}
              onClick={() => setOpen(false)}
              onFocus={() => setActiveIndex(index)}
            >
              {link.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
