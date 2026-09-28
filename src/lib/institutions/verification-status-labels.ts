// Indonesian labels for the platform_ops verification queue, shared by the admin institutions list
// and the moderation console.
//
// The record is keyed by `InstitutionVerificationStatus`, so adding a value to the
// institution_verification_status pgEnum without giving it a label here is a compile error.
import type { InstitutionVerificationStatus } from "@/server/db/schema";

export const INSTITUTION_VERIFICATION_STATUS_LABELS: Record<InstitutionVerificationStatus, string> =
  {
    pending_verification: "Menunggu Verifikasi",
    under_review: "Sedang Ditinjau",
    verified: "Terverifikasi Admin",
    rejected: "Ditolak Admin",
  };
