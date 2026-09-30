// Indonesian labels for an institution's platform status, shown to the organizer in the institution
// settings shell.
//
// The record is keyed by `InstitutionStatus`, so adding a value to the institution_status pgEnum
// without giving it a label here is a compile error.
import type { InstitutionStatus } from "@/server/db/schema";

export const INSTITUTION_STATUS_LABELS: Record<InstitutionStatus, string> = {
  active: "Aktif",
  inactive: "Nonaktif",
  suspended: "Ditangguhkan",
};
