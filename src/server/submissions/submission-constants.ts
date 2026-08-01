// Shared submission constants. Never inline these at call sites.
// Imported by the R2 presign flow (expiry), the upload-size policy, and the file-key
// generation/validation logic.

import { SUBMISSION_MAX_BYTES } from "@/lib/submissions/submission-file";

// Presigned PUT URL lifetime — 15 minutes. Long enough for a large file over a slow link,
// short enough to limit replay of a leaked URL.
export const SUBMISSIONS_UPLOAD_EXPIRY_SECONDS = 900;

// Upload size ceiling — 50 MB. Enforced twice: advisorily against the client-declared size when
// the payload is parsed, and authoritatively against the object's real size read back from R2
// before the row is written. Re-exported from the client-safe rules so the form and the server
// cannot drift onto two different ceilings.
export const SUBMISSIONS_MAX_FILE_SIZE_BYTES = SUBMISSION_MAX_BYTES;

// R2 object-key namespace for submissions.
//
// Layout: `submissions/{competitionId}/{registrationId}/{uuid}`.
//
// THE COMPETITION SEGMENT IS LOAD-BEARING and must not be dropped. Every bulk operation over
// submissions is per-competition — reclaiming abandoned uploads, and any future export or
// retention sweep — and the segment is what makes each of those a single prefix listing rather
// than a walk of whatever the database still remembers. Without it, an object the database has
// forgotten can never be found again. Same reasoning as the registration-documents layout.
export const SUBMISSIONS_KEY_PREFIX = "submissions";

// Every object belonging to one registration's submissions. Also the prefix the record path
// validates a client-supplied fileKey against, so a caller cannot claim a key scoped to another
// registration.
export const buildSubmissionRegistrationPrefix = (
  competitionId: string,
  registrationId: string,
): string => `${SUBMISSIONS_KEY_PREFIX}/${competitionId}/${registrationId}/`;

// Every object belonging to one competition's submissions, across all its registrations.
export const buildSubmissionCompetitionPrefix = (competitionId: string): string =>
  `${SUBMISSIONS_KEY_PREFIX}/${competitionId}/`;

// How long an UNFINALIZED submission is kept after a competition's event ends.
//
// A finalized submission is never purged: it is the entry, the thing a result rests on, and the
// participant's own work. An unfinalized one is abandoned draft material — uploaded, never
// submitted — and there is no verdict or result standing on it. Ninety days is long after the
// results window (event end + 7, plus a 7-day grace) so nothing an organizer is still legitimately
// reviewing is taken away underneath them.
//
// Deliberately a SEPARATE constant from DOCUMENT_RETENTION_GRACE_DAYS despite sharing a value:
// one bounds the exposure of holding students' identity documents, the other reclaims abandoned
// drafts. They answer different questions and should be free to diverge.
export const UNFINALIZED_SUBMISSION_RETENTION_GRACE_DAYS = 90;
