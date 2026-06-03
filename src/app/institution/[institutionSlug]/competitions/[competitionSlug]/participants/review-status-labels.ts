import type { CompetitionRegistrationReviewStatus } from "@/server/db/schema";

// Indonesian labels for the institution-internal review status. Shared by the
// participant list page and the per-registration review form.
export const REVIEW_STATUS_LABELS: Record<CompetitionRegistrationReviewStatus, string> = {
  pending_review: "Menunggu tinjauan",
  under_review: "Sedang ditinjau",
  shortlisted: "Masuk daftar pendek",
  rejected: "Ditolak",
};

export const REVIEW_STATUS_ORDER: CompetitionRegistrationReviewStatus[] = [
  "pending_review",
  "under_review",
  "shortlisted",
  "rejected",
];
