export const APP_ROLES = [
  "student",
  "institution_admin",
  "institution_staff",
  "reviewer_or_judge",
  "platform_ops",
  "finance_ops",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

export const DEFAULT_APP_ROLE: AppRole = "student";

export const isAppRole = (value: string): value is AppRole => {
  return (APP_ROLES as readonly string[]).includes(value);
};
