import { formatDisplayToken } from "@/lib/text/capitalize";

const APP_ROLE_LABELS: Record<string, string> = {
  candidate: "Kandidat",
  recruiter: "Rekruter",
  reviewer_or_judge: "Peninjau / juri",
  platform_ops: "Platform ops",
  finance_ops: "Finance ops",
};

const INSTITUTION_ROLE_LABELS: Record<string, string> = {
  institution_owner: "Pemilik",
  institution_staff: "Staf",
  institution_member: "Anggota",
};

const TEAM_ROLE_LABELS: Record<string, string> = {
  captain: "Kapten",
  member: "Anggota",
};

const resolveLabel = (labels: Record<string, string>, value: string): string =>
  labels[value] ?? formatDisplayToken(value);

export const getAppRoleLabel = (role: string): string => resolveLabel(APP_ROLE_LABELS, role);

export const getInstitutionRoleLabel = (role: string): string =>
  resolveLabel(INSTITUTION_ROLE_LABELS, role);

export const getTeamRoleLabel = (role: string): string => resolveLabel(TEAM_ROLE_LABELS, role);
