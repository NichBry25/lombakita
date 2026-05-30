// Step 4.6 — shared submission constants. Never inline these at call sites.
// Imported by the R2 presign flow (expiry), the upload-size policy, and the file-key
// generation/validation logic.

// Presigned PUT URL lifetime — 15 minutes. Long enough for a large file over a slow link,
// short enough to limit replay of a leaked URL.
export const SUBMISSIONS_UPLOAD_EXPIRY_SECONDS = 900;

// Upload size ceiling — 50 MB. Advisory at this step (the metadata-record path stores the
// client-reported size); enforced hard once a presigned-GET/validation pass lands.
export const SUBMISSIONS_MAX_FILE_SIZE_BYTES = 52_428_800;

// R2 object-key namespace for submissions. Generated keys are
// `submissions/{registrationId}/{uuid}`; the metadata-record path validates that a submitted
// fileKey starts with `submissions/{registrationId}/` before any DB write, so a caller cannot
// claim a key scoped to a different registration.
export const SUBMISSIONS_KEY_PREFIX = "submissions";
