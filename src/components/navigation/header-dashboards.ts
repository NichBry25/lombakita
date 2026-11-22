export type HeaderProfiles = {
  candidate: boolean;
  recruiter: boolean;
};

type HeaderDashboardRow = {
  key: keyof HeaderProfiles;
  href: string;
  menuLabel: string;
  sheetLabel: string;
  activateHref: string;
};

// A profile the account lacks is not hidden. The row stays and leads to the same role sign-up form
// that the dashboard itself redirects to.
export const HEADER_DASHBOARD_ROWS: readonly HeaderDashboardRow[] = [
  {
    key: "candidate",
    href: "/candidate-dashboard",
    menuLabel: "Kandidat",
    sheetLabel: "Dasbor kandidat",
    activateHref: "/auth/verify-role?as=candidate",
  },
  {
    key: "recruiter",
    href: "/recruiter-dashboard",
    menuLabel: "Penyelenggara",
    sheetLabel: "Dasbor penyelenggara",
    activateHref: "/auth/verify-role?as=recruiter",
  },
];

export function resolveDashboardRowTarget(row: HeaderDashboardRow, profiles: HeaderProfiles) {
  const hasProfile = profiles[row.key];
  return {
    href: hasProfile ? row.href : row.activateHref,
    needsActivation: !hasProfile,
  };
}

export function isOnDashboardRow(pathname: string, row: HeaderDashboardRow) {
  return pathname.startsWith(row.href);
}
