// Display state for a participant document request.
//
// Client-safe: the only import is a type, which is erased at compile time, so this module is
// importable from both the organizer console and the candidate dashboard without pulling the
// database layer into a client bundle.
//
// `unfulfilled` exists only here. It is never stored: a request whose deadline has passed with
// nothing uploaded is still `requested` in the database, and the lapsed state is computed against
// the clock at read time. Storing it would need a scheduled job to keep the column honest, and the
// column would be wrong for exactly as long as that job was late.

import type { RegistrationDocumentRequestStatus } from "@/server/db/schema";

export type RegistrationDocumentDisplayStatus =
  | "requested"
  | "unfulfilled"
  | "submitted"
  | "accepted"
  | "rejected"
  | "cancelled";

export type RegistrationDocumentDisplayState = {
  status: RegistrationDocumentDisplayStatus;
  // The deadline has passed and nothing has been uploaded. The organizer acts on this; nothing
  // happens automatically.
  isOverdue: boolean;
  // Something was uploaded, but after the deadline. Still a valid response — a request never
  // blocks the candidate — so this is a note for the reviewer, not a rejection.
  isLate: boolean;
};

export const deriveRequestDisplayStatus = (
  request: {
    status: RegistrationDocumentRequestStatus;
    dueAt: Date;
    submittedAt: Date | null;
  },
  now: Date = new Date(),
): RegistrationDocumentDisplayState => {
  const isLate =
    request.submittedAt !== null && request.submittedAt.getTime() > request.dueAt.getTime();

  if (request.status === "requested") {
    const isOverdue = request.dueAt.getTime() < now.getTime();
    return { status: isOverdue ? "unfulfilled" : "requested", isOverdue, isLate: false };
  }

  return { status: request.status, isOverdue: false, isLate };
};

// Indonesian labels. Single-word values are capitalized and multi-word values are sentence case,
// per the form and control standards.
export const DOCUMENT_REQUEST_STATUS_LABELS: Record<RegistrationDocumentDisplayStatus, string> = {
  requested: "Diminta",
  unfulfilled: "Tidak dipenuhi",
  submitted: "Menunggu peninjauan",
  accepted: "Diterima",
  rejected: "Ditolak",
  cancelled: "Dibatalkan",
};

// Maps a display status onto the shared `.status-badge` vocabulary in globals.css. Reuses the
// existing tokens rather than introducing a parallel set, so a document badge reads the same as
// every other badge in the app.
export const DOCUMENT_REQUEST_STATUS_TONES: Record<
  RegistrationDocumentDisplayStatus,
  "open" | "closing" | "eligible" | "ineligible" | "closed"
> = {
  requested: "open",
  // Urgent rather than failed: the deadline has passed, but the candidate may still upload and the
  // organizer has not yet decided anything.
  unfulfilled: "closing",
  submitted: "open",
  accepted: "eligible",
  rejected: "ineligible",
  cancelled: "closed",
};

// The statuses each verdict may act on.
//
// `accept` requires an upload, because there is nothing to accept without one. `reject` does not:
// a request that was never answered and a document that was answered and judged insufficient are
// both legitimate grounds. An uploaded file is never an argument for accepting it — an institution
// running zero tolerance must be able to refuse a document that is present, on time and perfectly
// legible, so `submitted` means awaiting a verdict and never provisionally accepted.
export const allowedSourceStatesForVerdict = (
  verdict: "accept" | "reject",
): RegistrationDocumentRequestStatus[] =>
  verdict === "accept" ? ["submitted"] : ["submitted", "requested"];

// A request is open while it is awaiting an upload or awaiting a verdict. Open requests are the
// ones the partial unique index allows only one of per registration.
export const isOpenRequestStatus = (status: RegistrationDocumentRequestStatus): boolean =>
  status === "requested" || status === "submitted";

// The candidate may attach or remove files only while the request is open — to swap a photo that
// cannot be read, including after a rejection has reopened the request.
//
// Once a verdict lands the document is frozen, accepted or rejected alike: it is the evidence that
// verdict rests on, and a record the organizer accepted is worth nothing if the subject can remove
// it afterwards. Purging it is a platform-side retention concern, not something either party
// reaches into by hand.
export const candidateMayModifyFiles = (status: RegistrationDocumentRequestStatus): boolean =>
  isOpenRequestStatus(status);
