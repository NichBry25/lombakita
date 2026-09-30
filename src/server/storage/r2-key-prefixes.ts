// The key templates every R2 upload surface writes under.
//
// These live here rather than in `scripts/project/deletion-census.ts`, where they were first
// written, because two readers need them and only one of those readers is a script. The census
// enumerates the prefixes to describe what a deletion reaches; a de-identification lists objects
// under them to delete them. A script may import from `src/` — the reverse direction is what this
// repository does not have and does not want.
//
// Each template is a KEY SPACE, not a key: the `{...}` segments are the ids that scope it, and a
// caller substitutes the ones it knows. A caller that knows only part of the path truncates after
// the last segment it can fill, which lists a superset and is the safe direction — an over-listed
// prefix is a delete that finds nothing, an under-listed one is an object left behind.

/** One profile photo per user. Writer: `src/server/user-profile/profile-files-service.ts`. */
export const R2_PREFIX_AVATARS = "avatars/{userId}/";

/** One profile banner per user. Writer: `src/server/user-profile/profile-files-service.ts`. */
export const R2_PREFIX_BANNERS = "banners/{userId}/";

/** One CV per user. Writer: `src/server/user-profile/profile-files-service.ts`. */
export const R2_PREFIX_RESUMES = "resumes/{userId}/";

/** Certification scans, one file per `profile_certifications` row. */
export const R2_PREFIX_PROFILE_CERTIFICATIONS = "profile-certifications/{userId}/";

/** Identity documents a recruiter uploaded to verify, one file per document row. */
export const R2_PREFIX_RECRUITER_VERIFICATION = "recruiter-verification/{userId}/{submissionId}/";

/** Competition entry files, keyed by the registration they were submitted for. */
export const R2_PREFIX_SUBMISSIONS = "submissions/{competitionId}/{registrationId}/";

/** Documents an organiser requested from a participant and the participant uploaded. */
export const R2_PREFIX_REGISTRATION_DOCUMENTS =
  "registration-documents/{competitionId}/{registrationId}/{requestId}/";

/** Bukti transfer images, recorded on rows DEC-0133 forbids deleting. */
export const R2_PREFIX_PAYMENT_PROOFS = "payment-proofs/{competitionId}/{paymentId}/";

/** The institution's QRIS image, recorded on its payment-instructions row. */
export const R2_PREFIX_PAYMENT_INSTRUCTIONS = "payment-instructions/{institutionId}/";

/** The institution's logo. */
export const R2_PREFIX_INSTITUTION_LOGOS = "institution-logos/{institutionId}/";

/** The institution's banner. */
export const R2_PREFIX_INSTITUTION_BANNERS = "institution-banners/{institutionId}/";

/** Institution legal documents, one file per verification document row. */
export const R2_PREFIX_VERIFICATION = "verification/{institutionId}/{submissionId}/";
