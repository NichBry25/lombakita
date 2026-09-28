// Indonesian labels for the competition lifecycle status, shared by every surface that shows a
// status to an organizer or an operator — the institution competition list and editor, the
// institution competition detail page, and the platform_ops payment console.
//
// The record is keyed by `CompetitionStatus`, so adding a value to the competition_status pgEnum
// without giving it a label here is a compile error.
import type { CompetitionStatus } from "@/server/db/schema";
import { formatDisplayToken } from "@/lib/text/capitalize";

export const COMPETITION_STATUS_LABELS: Record<CompetitionStatus, string> = {
  draft: "Draf",
  published: "Terbit",
  archived: "Diarsipkan",
};

// Resolve a stored status to its label, falling back to the raw value for any unrecognized string.
export const getCompetitionStatusLabel = (value: string | null | undefined): string => {
  if (!value) return "";
  return COMPETITION_STATUS_LABELS[value as CompetitionStatus] ?? formatDisplayToken(value);
};
