"use client";

import Link from "next/link";
import { Icon } from "@/components/ui";
import {
  HEADER_DASHBOARD_ROWS,
  isOnDashboardRow,
  resolveDashboardRowTarget,
  type HeaderProfiles,
} from "@/components/navigation/header-dashboards";
import { useHeaderMenu } from "@/components/navigation/use-header-menu";

const MENU_PANEL_ID = "header-dashboard-menu-panel";

type HeaderDashboardMenuProps = {
  pathname: string;
  profiles: HeaderProfiles;
};

// "Dasbor" nav dropdown: the WAI-ARIA menu-button pattern with real navigation links, so it uses
// menu and menuitem roles rather than the listbox roles of FilterDropdown. The caller mounts it
// only for a signed-in participant account. A row whose profile the account lacks stays in the
// menu with "Aktifkan" and leads to the role sign-up form.
export function HeaderDashboardMenu({ pathname, profiles }: HeaderDashboardMenuProps) {
  const {
    open,
    setOpen,
    setActiveIndex,
    rootRef,
    menuRef,
    toggleMenu,
    onTriggerKeyDown,
    onMenuKeyDown,
  } = useHeaderMenu(HEADER_DASHBOARD_ROWS.length);
  const isOnDashboard = HEADER_DASHBOARD_ROWS.some((row) => isOnDashboardRow(pathname, row));

  return (
    <div className="header-dashboard-menu-root" ref={rootRef}>
      <button
        type="button"
        className="header-nav-link header-dashboard-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={MENU_PANEL_ID}
        aria-current={isOnDashboard ? "page" : undefined}
        onClick={toggleMenu}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="header-nav-label" data-label="Dasbor">
          Dasbor
        </span>
        <Icon name="chevron-down" size="sm" className="header-dashboard-chevron" />
      </button>
      {open ? (
        <div
          id={MENU_PANEL_ID}
          className="header-dashboard-panel"
          role="menu"
          aria-label="Dasbor"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {HEADER_DASHBOARD_ROWS.map((row, index) => {
            const target = resolveDashboardRowTarget(row, profiles);
            const isCurrent = !target.needsActivation && isOnDashboardRow(pathname, row);
            return (
              <Link
                key={row.key}
                href={target.href}
                role="menuitem"
                tabIndex={-1}
                className="header-dashboard-menuitem"
                aria-current={isCurrent ? "page" : undefined}
                onClick={() => setOpen(false)}
                onFocus={() => setActiveIndex(index)}
              >
                {row.menuLabel}
                {target.needsActivation ? (
                  <span className="header-menu-status">Aktifkan</span>
                ) : null}
                {isCurrent ? <Icon name="check" /> : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
