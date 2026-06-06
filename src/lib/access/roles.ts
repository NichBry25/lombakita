export const APP_ROLES = [
  "candidate",
  "recruiter",
  "reviewer_or_judge",
  "platform_ops",
  "finance_ops",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

export const DEFAULT_APP_ROLE: AppRole = "candidate";

export const isAppRole = (value: string): value is AppRole => {
  return (APP_ROLES as readonly string[]).includes(value);
};

// Self-service account roles. A self-service account can hold BOTH of these verified at once
// (per-role verification timestamps), while its session JWT carries only the single role it
// signed in as. Operational roles are never self-service and never appear in verifiedRoles.
export const SELF_SERVICE_ROLES = ["candidate", "recruiter"] as const;

// Capability check for the DEC-0060 capability-based access model. The session JWT carries one
// active `role`, but a dual-verified self-service account (candidate AND recruiter) signed in
// under one role must still reach surfaces belonging to its other verified role. Authorization
// therefore consults the full verified-capability set, not just the single active role.
//
// Operational roles (platform_ops, finance_ops, reviewer_or_judge) never appear in verifiedRoles,
// so they are matched on the active role ONLY — folding verifiedRoles in is gated on the active
// role itself being self-service. This prevents an operational account whose candidate_verified_at
// is a migration CHECK-satisfier (not a real candidate mode) from being granted candidate access.
export const sessionHasRole = (
  activeRole: AppRole | string | null | undefined,
  verifiedRoles: readonly (AppRole | string)[] | null | undefined,
  required: AppRole,
): boolean => {
  const active = typeof activeRole === "string" && isAppRole(activeRole) ? activeRole : null;
  if (active === required) return true;
  if (active && (SELF_SERVICE_ROLES as readonly string[]).includes(active)) {
    const verified = Array.isArray(verifiedRoles)
      ? verifiedRoles.filter((r): r is AppRole => typeof r === "string" && isAppRole(r))
      : [];
    return verified.includes(required);
  }
  return false;
};
