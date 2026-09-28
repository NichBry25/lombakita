import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getDb, type Database } from "@/server/db/client";
import {
  accounts,
  candidateProfiles,
  competitionDocumentRequestFiles,
  competitionDocumentRequests,
  competitionRegistrations,
  competitionResults,
  competitionReviews,
  competitionSaves,
  competitionSubmissions,
  institutionInvitations,
  institutionMemberships,
  institutionPaymentInstructions,
  institutionSocialLinks,
  institutionVerificationDocuments,
  institutionVerificationSubmissions,
  institutions,
  mfaFactors,
  mfaRecoveryCodes,
  notifications,
  platformOpsNotes,
  profileCertifications,
  profileEducations,
  profileExperiences,
  profileSkills,
  profileSocialLinks,
  recruiterVerificationDocuments,
  recruiterVerificationSubmissions,
  sessions,
  teamInvitations,
  userEmailVerificationTokens,
  userPasswordCredentials,
  userPlatformRoles,
  userProfiles,
  users,
  verificationTokens,
} from "@/server/db/schema";
import {
  OperatorActorError,
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
  type OperatorActorTransaction,
} from "@/server/platform-ops/operator-actor";
import { deleteObject, isR2Available, listObjects } from "@/server/storage/r2.client";
import {
  R2_PREFIX_AVATARS,
  R2_PREFIX_BANNERS,
  R2_PREFIX_INSTITUTION_BANNERS,
  R2_PREFIX_INSTITUTION_LOGOS,
  R2_PREFIX_PAYMENT_INSTRUCTIONS,
  R2_PREFIX_PROFILE_CERTIFICATIONS,
  R2_PREFIX_RECRUITER_VERIFICATION,
  R2_PREFIX_REGISTRATION_DOCUMENTS,
  R2_PREFIX_RESUMES,
  R2_PREFIX_SUBMISSIONS,
  R2_PREFIX_VERIFICATION,
} from "@/server/storage/r2-key-prefixes";
import { findOwnedPersonalInstitution } from "@/server/institution-workspace/institution-service";
import {
  DEIDENTIFIED_DISPLAY_NAME,
  DEIDENTIFIED_INSTITUTION_NAME,
  DEIDENTIFIED_INSTITUTION_SUSPENSION_REASON,
  DEIDENTIFIED_SUSPENSION_REASON,
  DEIDENTIFIED_TEXT,
  deidentifiedEmail,
  deidentifiedUsername,
} from "@/server/accounts/deidentified-identity";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/accounts/account-deidentification-service");

// De-identify an account on its owner's request (LAUNCH-D104, LAUNCH-D172, TRUST-D12).
//
// The action is "completely and always": every file the person uploaded is deleted from storage,
// every row that exists only because they exist is removed, and every row other people depend on
// survives with the person's own text stripped out. `users` keeps the row and becomes a tombstone,
// which is what stops the account signing in again — the address it now holds can never resolve
// and the route's own suppression branch refuses to send to it.
//
// THREE ORDERED STAGES, and the order is the whole of the safety story.
//   rehearsal → storage → commit
// Every write the action performs runs to completion inside a transaction that always rolls back,
// before a single object is removed. A constraint, a permission problem or a bug that would fail
// the real transaction therefore fails while the account is still whole. Storage runs second,
// because an object delete cannot be rolled back: once it has happened the only way to finish is to
// run the action again, which is safe precisely because the commit has not happened yet. The
// commit is last, and it re-runs every precondition from the start.
//
// THE ACTOR IS RESOLVED TWICE, and that is deliberate (LAUNCH-D141). The pre-read resolves it to
// answer "may this account be the target", and the writing transaction resolves it AGAIN from its
// own handle rather than accepting the earlier value: a resolution taken outside the writing
// transaction is one a suspension can overtake, and the audit row this action writes must not name
// an actor the database has since stopped vouching for.
//
// WHAT CAN SURVIVE, stated rather than implied, and recorded as open debt in
// `docs/operations/account-deletion-procedure.md`: an object uploaded through a presigned URL that
// was minted before this operation ran, and a registration created between the rehearsal and the
// commit. The second is why the prefix list comes from the rehearsal's read rather than the
// pre-read's — the narrower gap, not a closed one. Neither is a reason to re-open an account the
// commit has already finished with.

export type DeidentificationErrorCode =
  | "deidentify_invalid_payload"
  | "deidentify_reason_required"
  | "deidentify_account_not_found"
  | "deidentify_target_is_operator"
  | "deidentify_already_done"
  | "deidentify_confirmation_mismatch"
  | "deidentify_last_owner"
  | "deidentify_personal_institution_has_published_competition"
  | "deidentify_storage_unavailable"
  | "deidentify_rehearsal_failed"
  | "deidentify_storage_failed";

export class DeidentificationError extends Error {
  constructor(
    public readonly code: DeidentificationErrorCode,
    public readonly status: 400 | 403 | 404 | 409 | 500 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

// Audit event type. Distinct from `recruiter_tier.elevated` and from every suspension event: a
// reader of the trail must be able to tell "this account was de-identified" from "this account was
// suspended", because only the first is irreversible.
export const ACCOUNT_DEIDENTIFIED_EVENT = "account_deidentified";

export type DeidentifyAccountInput = {
  confirmUsername: string;
  reason: string;
};

export type DeidentifyAccountResult = {
  objectsDeleted: number;
  personalInstitutionId: string | null;
};

/**
 * The route's shape check, and only that. `deidentify_invalid_payload` is this module's counterpart
 * to `tier_invalid_payload` on the elevation route, and it is the one code here that no sentence in
 * the action's own vocabulary covers — a body that is not an object, or whose two fields are not
 * both strings, is not a confirmation that failed or a reason that is missing. Both of those are
 * decided later, by the vocabulary that means them.
 */
export const parseDeidentifyInput = (payload: unknown): DeidentifyAccountInput => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new DeidentificationError(
      "deidentify_invalid_payload",
      400,
      "Request body must be a JSON object",
    );
  }

  const { confirmUsername, reason } = payload as {
    confirmUsername?: unknown;
    reason?: unknown;
  };

  if (typeof confirmUsername !== "string" || typeof reason !== "string") {
    throw new DeidentificationError(
      "deidentify_invalid_payload",
      400,
      "confirmUsername and reason must both be strings",
    );
  }

  return { confirmUsername, reason };
};

/** One registration the target holds. Carried as a pair because the R2 scope needs both ids. */
type TargetRegistration = {
  registrationId: string;
  competitionId: string;
};

type TargetFacts = {
  originalEmail: string;
  registrations: TargetRegistration[];
  personalInstitutionId: string | null;
};

type WriteOutcome = {
  rowsDeleted: Record<string, number>;
  rowsScrubbed: Record<string, number>;
  personalInstitutionId: string | null;
  // Carried out of the transaction because the storage stage needs them and must not read them for
  // itself: a listing taken before the stage runs is a listing a concurrent registration can overtake.
  registrations: TargetRegistration[];
};

// Thrown inside the rehearsal transaction to force its rollback. Never escapes `performWrites`:
// the catch there recognises it and returns the counts it carries, so the rehearsal's own writes
// are discarded while its measurements are kept.
class RehearsalRollback extends Error {
  constructor(readonly written: WriteOutcome) {
    super("rehearsal rollback");
  }
}

// ---------------------------------------------------------------------------------------------
// Preconditions.

const assertReasonPresent = (input: DeidentifyAccountInput): void => {
  if (input.reason.trim().length === 0) {
    throw new DeidentificationError("deidentify_reason_required", 400, "Alasan wajib diisi.");
  }
};

// The `preflight-owners` predicate from docs/operations/account-deletion-procedure.md, narrowed to
// institutions that are NOT personal.
//
// The narrowing is the difference between the two operations. The procedure hard-deletes the
// account and its memberships, so an institution left without an active owner is left standing and
// unadministrable for everyone. This action de-identifies instead: the owner's membership is
// revoked but the row survives, and a PERSONAL institution belongs to exactly that one person, so
// it is suspended and scrubbed by the caller rather than treated as orphaned. A full institution
// has staff and members who would be stranded, which is what the refusal is for.
//
// `is distinct from 'personal'` and not `<> 'personal'`: a legacy institution carries a NULL type,
// and `NULL <> 'personal'` is NULL, which excludes the row — the exact mistake the taxonomy note in
// institution-type.ts warns about.
const findInstitutionsWhereTargetIsLastActiveOwner = async (
  tx: OperatorActorTransaction,
  accountId: string,
): Promise<string[]> => {
  const rows = await tx.execute(sql`
    select i.slug
    from institutions i
    where i.institution_type is distinct from 'personal'
      and exists (
        select 1 from institution_memberships mine
        where mine.institution_id = i.id
          and mine.user_id = ${accountId}
          and mine.membership_role = 'institution_owner'
          and mine.status = 'active'
      )
      and not exists (
        select 1 from institution_memberships other
        where other.institution_id = i.id
          and other.membership_role = 'institution_owner'
          and other.status = 'active'
          and other.user_id <> ${accountId}
      )
    order by i.slug
  `);

  return [...rows].map((row) => (row as { slug: string }).slug);
};

const assertNotLastActiveOwner = async (
  tx: OperatorActorTransaction,
  accountId: string,
): Promise<void> => {
  const slugs = await findInstitutionsWhereTargetIsLastActiveOwner(tx, accountId);

  if (slugs.length > 0) {
    throw new DeidentificationError(
      "deidentify_last_owner",
      409,
      `Akun ini pemilik terakhir institusi: ${slugs.join(", ")}. Pindahkan kepemilikan terlebih dahulu.`,
    );
  }
};

const assertNoPublishedPersonalCompetition = async (
  tx: OperatorActorTransaction,
  personalInstitutionId: string | null,
): Promise<void> => {
  if (personalInstitutionId === null) {
    return;
  }

  const rows = await tx.execute(sql`
    select c.slug
    from competitions c
    where c.institution_id = ${personalInstitutionId}
      and c.status = 'published'
    order by c.slug
  `);

  const slugs = [...rows].map((row) => (row as { slug: string }).slug);

  if (slugs.length > 0) {
    throw new DeidentificationError(
      "deidentify_personal_institution_has_published_competition",
      409,
      `Institusi pribadi akun ini masih punya kompetisi terbit: ${slugs.join(", ")}. Arsipkan atau batalkan dulu.`,
    );
  }
};

/**
 * Every refusal the action makes against its target, in one sequence, ending with the facts the
 * caller needs afterwards.
 *
 * ONE FUNCTION FOR BOTH CALLERS. The pre-read and the writing transaction run the same checks in
 * the same order, rather than two copies of the sequence that would drift apart invisibly. The
 * writing transaction is the one that has to be right, and it is the only one whose answer is
 * carried out of it.
 *
 * `deactivated` MEANS DONE, in both callers and on status alone. The commit is the last of the
 * three stages, so every failure before it leaves the account not deactivated and a rerun finds it
 * eligible; there is no interrupted state this action has to resume. An account that does read
 * deactivated with objects still under its prefixes is one an upload raced — an object uploaded
 * through a presigned URL minted before this operation — and `deleteObjectsUnder` has already run by
 * then, so the object is not reachable from any prefix this action listed. The other survivor is a
 * registration created between the rehearsal and the commit: the commit scrubs its row and the
 * objects under its prefixes were never listed. Both are open debt (see the module header) rather
 * than a reason to re-open a finished account.
 */
const assertTargetIsEligible = async (
  tx: OperatorActorTransaction,
  accountId: string,
  input: DeidentifyAccountInput,
): Promise<TargetFacts> => {
  const [target] = await tx
    .select({
      email: users.email,
      username: users.username,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);

  if (target === undefined) {
    throw new DeidentificationError("deidentify_account_not_found", 404, "Akun tidak ditemukan.");
  }

  if (target.role === "platform_ops") {
    throw new DeidentificationError(
      "deidentify_target_is_operator",
      403,
      "Akun operator tidak dapat dihapus lewat tindakan ini.",
    );
  }

  if (target.status === "deactivated") {
    throw new DeidentificationError(
      "deidentify_already_done",
      409,
      "Data akun ini sudah dihapus sebelumnya.",
    );
  }

  // Exact and case-sensitive: the operator is asked to type the username they can see, and a
  // near-match is not a confirmation.
  if (input.confirmUsername !== target.username) {
    throw new DeidentificationError(
      "deidentify_confirmation_mismatch",
      400,
      "Nama pengguna konfirmasi tidak cocok.",
    );
  }

  await assertNotLastActiveOwner(tx, accountId);

  const personalInstitution = await findOwnedPersonalInstitution(accountId, tx);
  const personalInstitutionId = personalInstitution?.institutionId ?? null;

  await assertNoPublishedPersonalCompetition(tx, personalInstitutionId);

  const registrations = await tx
    .select({
      registrationId: competitionRegistrations.id,
      competitionId: competitionRegistrations.competitionId,
    })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.studentId, accountId));

  return {
    originalEmail: target.email,
    registrations,
    personalInstitutionId,
  };
};

// ---------------------------------------------------------------------------------------------
// The storage stage.

const fillUserPrefix = (template: string, userId: string): string =>
  template.replace("{userId}", userId);

const fillInstitutionPrefix = (template: string, institutionId: string): string =>
  template.replace("{institutionId}", institutionId);

const fillRegistrationPrefix = (template: string, registration: TargetRegistration): string =>
  template
    .replace("{competitionId}", registration.competitionId)
    .replace("{registrationId}", registration.registrationId);

// The template up to and including `placeholder`, so a caller that knows only the outer scope lists
// a superset rather than guessing at the inner ids. The superset direction is the safe one: an
// over-listed prefix finds nothing, an under-listed one leaves the file behind.
//
// It runs on the RAW template, before any substitution: `{userId}` names a placeholder only while
// the braces are still in it.
const prefixUpTo = (template: string, placeholder: string): string => {
  const end = template.indexOf(placeholder);

  if (end === -1) {
    throw new Error(`${placeholder} is not a placeholder of ${template}`);
  }

  return template.slice(0, end + placeholder.length);
};

/**
 * Every R2 prefix the action deletes under, for one target.
 *
 * `payment-proofs/` is absent on purpose and must stay absent. Those objects sit behind rows
 * DEC-0133 forbids deleting — the ledger is append-only and a payment proof is evidence — so
 * removing the image would leave an immutable row pointing at nothing.
 */
export const deidentificationObjectPrefixes = (target: {
  userId: string;
  registrations: readonly TargetRegistration[];
  personalInstitutionId: string | null;
}): string[] => {
  const prefixes = [
    fillUserPrefix(R2_PREFIX_AVATARS, target.userId),
    fillUserPrefix(R2_PREFIX_BANNERS, target.userId),
    fillUserPrefix(R2_PREFIX_RESUMES, target.userId),
    fillUserPrefix(R2_PREFIX_PROFILE_CERTIFICATIONS, target.userId),
    fillUserPrefix(prefixUpTo(R2_PREFIX_RECRUITER_VERIFICATION, "{userId}/"), target.userId),
  ];

  for (const registration of target.registrations) {
    prefixes.push(
      fillRegistrationPrefix(R2_PREFIX_SUBMISSIONS, registration),
      fillRegistrationPrefix(
        prefixUpTo(R2_PREFIX_REGISTRATION_DOCUMENTS, "{registrationId}/"),
        registration,
      ),
    );
  }

  if (target.personalInstitutionId !== null) {
    prefixes.push(
      fillInstitutionPrefix(R2_PREFIX_INSTITUTION_LOGOS, target.personalInstitutionId),
      fillInstitutionPrefix(R2_PREFIX_INSTITUTION_BANNERS, target.personalInstitutionId),
      fillInstitutionPrefix(R2_PREFIX_PAYMENT_INSTRUCTIONS, target.personalInstitutionId),
      fillInstitutionPrefix(
        prefixUpTo(R2_PREFIX_VERIFICATION, "{institutionId}/"),
        target.personalInstitutionId,
      ),
    );
  }

  return prefixes;
};

// Thrown the moment a storage call fails, carrying how many objects were already removed. The
// count is the difference between an operator who knows a rerun will finish the job and one who
// does not know what state they are in.
class StorageDeletionFailure extends Error {
  constructor(readonly objectsDeleted: number) {
    super("storage deletion failed");
  }
}

/**
 * Delete every object under `prefixes`, counting as it goes.
 *
 * The underlying error is deliberately not carried. An S3 failure quotes the key it failed on, and
 * a key contains the account or registration id it was built from — so propagating it would put a
 * value from the deleted person's record into a log, an error detail and an HTTP response. The
 * count is what the caller can act on and is all that is kept.
 */
const deleteObjectsUnder = async (prefixes: readonly string[]): Promise<number> => {
  let objectsDeleted = 0;

  try {
    for (const prefix of prefixes) {
      const objects = await listObjects(prefix);

      for (const object of objects) {
        await deleteObject(object.key);
        objectsDeleted += 1;
      }
    }
  } catch {
    throw new StorageDeletionFailure(objectsDeleted);
  }

  return objectsDeleted;
};

// ---------------------------------------------------------------------------------------------
// The writes.

/**
 * Every write the action performs, against a transaction handle the caller owns.
 *
 * Called twice with the same arguments: once inside a transaction that rolls back, once inside the
 * one that commits. It does not know which, and it must not — a rehearsal flag threaded through
 * here would be a second code path wearing the first one's name.
 */
const runDeidentificationWrites = async (
  tx: OperatorActorTransaction,
  actorUserId: string,
  accountId: string,
  input: DeidentifyAccountInput,
): Promise<WriteOutcome> => {
  // Resolved from THIS handle, never passed in (LAUNCH-D141). An actor resolved in the pre-read is
  // one a suspension can overtake before this row is written.
  const actor = await resolvePlatformOpsActor(tx, actorUserId);

  if (actor.userId === accountId) {
    throw new OperatorActorError(
      "operator_actor_is_target",
      403,
      "Anda tidak dapat menghapus akun Anda sendiri.",
    );
  }

  // Held for the rest of the transaction, so a concurrent run blocks here and then finds the row
  // deactivated at the CAS rather than interleaving deletes with this one.
  await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId)).for("update");

  // The pre-read's values are not reused: this transaction answers every question itself, from its
  // own handle and under its own lock. That covers the personal institution, which is resolved
  // here rather than handed in — an upgrade or a revocation between the two stages would otherwise
  // leave this run writing to an institution the pre-read chose.
  const facts = await assertTargetIsEligible(tx, accountId, input);
  const personalInstitutionId = facts.personalInstitutionId;

  const rowsDeleted: Record<string, number> = {};
  const rowsScrubbed: Record<string, number> = {};

  const deleteFrom = async (table: string, remove: () => Promise<unknown[]>): Promise<void> => {
    rowsDeleted[table] = (await remove()).length;
  };

  const scrubIn = async (table: string, update: () => Promise<unknown[]>): Promise<void> => {
    rowsScrubbed[table] = (await update()).length;
  };

  const registrationIds = facts.registrations.map((registration) => registration.registrationId);

  const flipped = await tx
    .update(users)
    .set({
      name: DEIDENTIFIED_DISPLAY_NAME,
      email: deidentifiedEmail(accountId),
      username: deidentifiedUsername(accountId),
      image: null,
      status: "deactivated",
      suspendedAt: sql`now()`,
      suspensionReason: DEIDENTIFIED_SUSPENSION_REASON,
      updatedAt: sql`now()`,
    })
    .where(and(eq(users.id, accountId), ne(users.status, "deactivated")))
    .returning({ id: users.id });

  if (flipped.length === 0) {
    throw new DeidentificationError(
      "deidentify_already_done",
      409,
      "Data akun ini sudah dihapus sebelumnya.",
    );
  }

  await deleteFrom("accounts", () =>
    tx.delete(accounts).where(eq(accounts.userId, accountId)).returning({ id: accounts.userId }),
  );

  await deleteFrom("sessions", () =>
    tx.delete(sessions).where(eq(sessions.userId, accountId)).returning({ id: sessions.userId }),
  );

  await deleteFrom("user_password_credentials", () =>
    tx
      .delete(userPasswordCredentials)
      .where(eq(userPasswordCredentials.userId, accountId))
      .returning({ id: userPasswordCredentials.userId }),
  );

  await deleteFrom("user_email_verification_tokens", () =>
    tx
      .delete(userEmailVerificationTokens)
      .where(eq(userEmailVerificationTokens.userId, accountId))
      .returning({ id: userEmailVerificationTokens.id }),
  );

  await deleteFrom("mfa_factors", () =>
    tx.delete(mfaFactors).where(eq(mfaFactors.userId, accountId)).returning({ id: mfaFactors.id }),
  );

  await deleteFrom("mfa_recovery_codes", () =>
    tx
      .delete(mfaRecoveryCodes)
      .where(eq(mfaRecoveryCodes.userId, accountId))
      .returning({ id: mfaRecoveryCodes.id }),
  );

  await deleteFrom("user_platform_roles", () =>
    tx
      .delete(userPlatformRoles)
      .where(eq(userPlatformRoles.userId, accountId))
      .returning({ id: userPlatformRoles.userId }),
  );

  await deleteFrom("profile_certifications", () =>
    tx
      .delete(profileCertifications)
      .where(eq(profileCertifications.userId, accountId))
      .returning({ id: profileCertifications.id }),
  );

  await deleteFrom("profile_educations", () =>
    tx
      .delete(profileEducations)
      .where(eq(profileEducations.userId, accountId))
      .returning({ id: profileEducations.id }),
  );

  await deleteFrom("profile_experiences", () =>
    tx
      .delete(profileExperiences)
      .where(eq(profileExperiences.userId, accountId))
      .returning({ id: profileExperiences.id }),
  );

  await deleteFrom("profile_skills", () =>
    tx
      .delete(profileSkills)
      .where(eq(profileSkills.userId, accountId))
      .returning({ id: profileSkills.id }),
  );

  await deleteFrom("profile_social_links", () =>
    tx
      .delete(profileSocialLinks)
      .where(eq(profileSocialLinks.userId, accountId))
      .returning({ id: profileSocialLinks.id }),
  );

  await deleteFrom("notifications", () =>
    tx
      .delete(notifications)
      .where(eq(notifications.userId, accountId))
      .returning({ id: notifications.id }),
  );

  await deleteFrom("competition_saves", () =>
    tx
      .delete(competitionSaves)
      .where(eq(competitionSaves.userId, accountId))
      .returning({ id: competitionSaves.competitionId }),
  );

  // The candidate onboarding profile carries a NOT NULL occupation enum and date of birth, so it
  // cannot be scrubbed into a row that still satisfies its own columns; it exists only for the
  // person, so it goes.
  await deleteFrom("candidate_profiles", () =>
    tx
      .delete(candidateProfiles)
      .where(eq(candidateProfiles.userId, accountId))
      .returning({ id: candidateProfiles.userId }),
  );

  // Auth.js address-keyed token. Read from the pre-update email, because the row's key is the
  // address the account signed up with and the update above has already replaced it.
  await deleteFrom("verification_tokens", () =>
    tx
      .delete(verificationTokens)
      .where(eq(verificationTokens.identifier, facts.originalEmail))
      .returning({ id: verificationTokens.token }),
  );

  await deleteFrom("recruiter_verification_documents", () =>
    tx
      .delete(recruiterVerificationDocuments)
      .where(
        inArray(
          recruiterVerificationDocuments.submissionId,
          tx
            .select({ id: recruiterVerificationSubmissions.id })
            .from(recruiterVerificationSubmissions)
            .where(eq(recruiterVerificationSubmissions.userId, accountId)),
        ),
      )
      .returning({ id: recruiterVerificationDocuments.id }),
  );

  await deleteFrom("recruiter_verification_submissions", () =>
    tx
      .delete(recruiterVerificationSubmissions)
      .where(eq(recruiterVerificationSubmissions.userId, accountId))
      .returning({ id: recruiterVerificationSubmissions.id }),
  );

  // Invitations addressed to the person, by id or by an address that resolves to them. `lower()`
  // on both sides because an address is matched the way a mail system would match it.
  await deleteFrom("institution_invitations", () =>
    tx
      .delete(institutionInvitations)
      .where(
        or(
          eq(institutionInvitations.targetUserId, accountId),
          sql`lower(${institutionInvitations.invitedEmail}) = lower(${facts.originalEmail})`,
        ),
      )
      .returning({ id: institutionInvitations.id }),
  );

  await deleteFrom("team_invitations", () =>
    tx
      .delete(teamInvitations)
      .where(
        or(
          eq(teamInvitations.targetUserId, accountId),
          sql`lower(${teamInvitations.invitedEmail}) = lower(${facts.originalEmail})`,
        ),
      )
      .returning({ id: teamInvitations.id }),
  );

  await deleteFrom("platform_ops_notes", () =>
    tx
      .delete(platformOpsNotes)
      .where(eq(platformOpsNotes.targetUserId, accountId))
      .returning({ id: platformOpsNotes.id }),
  );

  await deleteFrom("competition_document_request_files", () =>
    registrationIds.length === 0
      ? Promise.resolve([])
      : tx
          .delete(competitionDocumentRequestFiles)
          .where(
            inArray(
              competitionDocumentRequestFiles.requestId,
              tx
                .select({ id: competitionDocumentRequests.id })
                .from(competitionDocumentRequests)
                .where(inArray(competitionDocumentRequests.registrationId, registrationIds)),
            ),
          )
          .returning({ id: competitionDocumentRequestFiles.id }),
  );

  // The profile shell survives: it hangs off the account row other people's records do not point
  // at, but deleting it is not what the enumeration asks for and a missing row is indistinguishable
  // from a never-filled one on the read paths that use it.
  await scrubIn("user_profiles", () =>
    tx
      .update(userProfiles)
      .set({
        displayName: DEIDENTIFIED_DISPLAY_NAME,
        phoneNumber: null,
        avatarUrl: null,
        avatarR2Key: null,
        bannerR2Key: null,
        summary: null,
        location: null,
        resumeR2Key: null,
        resumeFileName: null,
        resumeSizeBytes: null,
        resumeMimeType: null,
        resumeUploadedAt: null,
        resumePublic: false,
        updatedAt: sql`now()`,
      })
      .where(eq(userProfiles.userId, accountId))
      .returning({ id: userProfiles.userId }),
  );

  await scrubIn("competition_registrations", () =>
    tx
      .update(competitionRegistrations)
      .set({ internalNotes: null, updatedAt: sql`now()` })
      .where(eq(competitionRegistrations.studentId, accountId))
      .returning({ id: competitionRegistrations.id }),
  );

  // `result_label` is kept: it is the placement other people's records report, and the row exists
  // because the entry counted, not because the person wrote anything on it.
  await scrubIn("competition_results", () =>
    registrationIds.length === 0
      ? Promise.resolve([])
      : tx
          .update(competitionResults)
          .set({ resultNotes: null, updatedAt: sql`now()` })
          .where(inArray(competitionResults.registrationId, registrationIds))
          .returning({ id: competitionResults.id }),
  );

  await scrubIn("competition_submissions", () =>
    registrationIds.length === 0
      ? Promise.resolve([])
      : tx
          .update(competitionSubmissions)
          .set({ fileKey: DEIDENTIFIED_TEXT, fileName: DEIDENTIFIED_TEXT, updatedAt: sql`now()` })
          .where(inArray(competitionSubmissions.registrationId, registrationIds))
          .returning({ id: competitionSubmissions.id }),
  );

  // `title` and `instructions` are the organiser's words to whoever holds the registration, so
  // they stay; only the reviewer's note about this person is theirs.
  await scrubIn("competition_document_requests", () =>
    registrationIds.length === 0
      ? Promise.resolve([])
      : tx
          .update(competitionDocumentRequests)
          .set({ reviewNote: null, updatedAt: sql`now()` })
          .where(inArray(competitionDocumentRequests.registrationId, registrationIds))
          .returning({ id: competitionDocumentRequests.id }),
  );

  await scrubIn("competition_reviews", () =>
    tx
      .update(competitionReviews)
      .set({ body: null, updatedAt: sql`now()` })
      .where(eq(competitionReviews.authorUserId, accountId))
      .returning({ id: competitionReviews.id }),
  );

  // Revoked, not deleted: the membership row is what tells a reader the institution once had this
  // owner, and deleting it is what the `preflight-owners` predicate exists to prevent elsewhere.
  await scrubIn("institution_memberships", () =>
    tx
      .update(institutionMemberships)
      .set({ status: "revoked", updatedAt: sql`now()` })
      .where(eq(institutionMemberships.userId, accountId))
      .returning({ id: institutionMemberships.id }),
  );

  if (personalInstitutionId !== null) {
    await scrubIn("institutions", () =>
      tx
        .update(institutions)
        .set({
          displayName: DEIDENTIFIED_INSTITUTION_NAME,
          slug: `deleted-${personalInstitutionId}`,
          description: null,
          rejectionReason: null,
          logoR2Key: null,
          bannerR2Key: null,
          about: null,
          contactName: null,
          contactEmail: null,
          contactPhone: null,
          websiteUrl: null,
          suspendedAt: sql`now()`,
          suspensionReason: DEIDENTIFIED_INSTITUTION_SUSPENSION_REASON,
          updatedAt: sql`now()`,
        })
        .where(eq(institutions.id, personalInstitutionId))
        .returning({ id: institutions.id }),
    );

    await deleteFrom("institution_social_links", () =>
      tx
        .delete(institutionSocialLinks)
        .where(eq(institutionSocialLinks.institutionId, personalInstitutionId))
        .returning({ id: institutionSocialLinks.id }),
    );

    // Deleted rather than scrubbed: `institution_payment_instructions_payable_chk` requires a QRIS
    // key or a complete bank triple, so a scrubbed row cannot exist. An institution with no
    // instructions has no row, which is a state every reader already handles.
    await deleteFrom("institution_payment_instructions", () =>
      tx
        .delete(institutionPaymentInstructions)
        .where(eq(institutionPaymentInstructions.institutionId, personalInstitutionId))
        .returning({ id: institutionPaymentInstructions.id }),
    );

    await scrubIn("institution_verification_documents", () =>
      tx
        .update(institutionVerificationDocuments)
        .set({
          documentType: DEIDENTIFIED_TEXT,
          r2Key: DEIDENTIFIED_TEXT,
          originalFileName: DEIDENTIFIED_TEXT,
          contentType: DEIDENTIFIED_TEXT,
        })
        .where(
          inArray(
            institutionVerificationDocuments.submissionId,
            tx
              .select({ id: institutionVerificationSubmissions.id })
              .from(institutionVerificationSubmissions)
              .where(eq(institutionVerificationSubmissions.institutionId, personalInstitutionId)),
          ),
        )
        .returning({ id: institutionVerificationDocuments.id }),
    );

    // The submission wrapper survives the documents it carries: it is a row in the institution's own
    // verification history, and the history is kept. What it holds of the person is the name they
    // asked to trade under and the reviewer's prose about them.
    await scrubIn("institution_verification_submissions", () =>
      tx
        .update(institutionVerificationSubmissions)
        .set({ proposedDisplayName: null, reviewerNotes: null })
        .where(eq(institutionVerificationSubmissions.institutionId, personalInstitutionId))
        .returning({ id: institutionVerificationSubmissions.id }),
    );
  } else {
    rowsScrubbed.institutions = 0;
    rowsDeleted.institution_social_links = 0;
    rowsDeleted.institution_payment_instructions = 0;
    rowsScrubbed.institution_verification_documents = 0;
    rowsScrubbed.institution_verification_submissions = 0;
  }

  await recordOperatorAuditEntry(tx, actor, {
    targetUserId: accountId,
    eventType: ACCOUNT_DEIDENTIFIED_EVENT,
    reason: input.reason.trim(),
    metadata: {
      rowsDeleted,
      rowsScrubbed,
      personalInstitutionId,
    },
  });

  return { rowsDeleted, rowsScrubbed, personalInstitutionId, registrations: facts.registrations };
};

// ---------------------------------------------------------------------------------------------
// Stage driver.

/**
 * Run the writes, either committing them or discarding them.
 *
 * `.catch` rather than a try/catch around the transaction so the sentinel is recognised without
 * also swallowing the caller's own refusals: a `DeidentificationError` from the re-run preconditions
 * is not the sentinel and must reach the caller unchanged.
 */
const performWrites = async (
  db: Database,
  actorUserId: string,
  accountId: string,
  input: DeidentifyAccountInput,
  rehearsal: boolean,
): Promise<WriteOutcome> => {
  let rollbackThrown = false;

  const outcome = await db
    .transaction(async (tx) => {
      const written = await runDeidentificationWrites(tx, actorUserId, accountId, input);

      if (rehearsal) {
        rollbackThrown = true;

        throw new RehearsalRollback(written);
      }

      return written;
    })
    .catch((error: unknown) => {
      if (error instanceof RehearsalRollback) {
        return error.written;
      }

      throw error;
    });

  // A rehearsal that reached this line committed. That is the one outcome the rehearsal exists to
  // make impossible, so it is a hard failure rather than a silent real deletion.
  if (rehearsal && !rollbackThrown) {
    throw new Error("the rehearsal transaction committed: the rollback sentinel was not thrown");
  }

  return outcome;
};

const constraintNameOf = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const constraint = (error as { constraint?: unknown }).constraint;

  return typeof constraint === "string" ? constraint : null;
};

const sqlStateOf = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === "string" ? code : null;
};

/**
 * De-identify one account.
 *
 * Read the module header for why the three stages are ordered the way they are; this function is
 * that order and nothing else.
 */
export const deidentifyAccount = async (
  actorUserId: string,
  accountId: string,
  input: DeidentifyAccountInput,
  db: Database = getDb(),
): Promise<DeidentifyAccountResult> => {
  // Before anything: without storage there is no way to delete the person's files, and an account
  // de-identified with its files still in the bucket is the outcome this action exists to prevent.
  if (!isR2Available()) {
    throw new DeidentificationError(
      "deidentify_storage_unavailable",
      503,
      "Penyimpanan berkas tidak tersedia. Coba lagi nanti.",
    );
  }

  // Read for its refusals and nothing else. The facts it resolves are not carried forward: the
  // storage stage lists the prefixes the REHEARSAL resolved, because an account can gain a
  // registration between this read and that one (LAUNCH-D104).
  await db.transaction(async (tx) => {
    assertReasonPresent(input);

    const actor = await resolvePlatformOpsActor(tx, actorUserId);

    if (actor.userId === accountId) {
      throw new OperatorActorError(
        "operator_actor_is_target",
        403,
        "Anda tidak dapat menghapus akun Anda sendiri.",
      );
    }

    // No R2 listing here. `deactivated` on its own is the whole of the signal: the commit is the
    // last of the three stages, so anything that failed before it left the row active and a rerun
    // completes the work. Reading storage to tell a finished account from an interrupted one would
    // buy a resumed path this action has no other half of — `deleteObjectsUnder` runs before the
    // commit, never after it.
    await assertTargetIsEligible(tx, accountId, input);
  });

  let rehearsal: WriteOutcome;

  try {
    rehearsal = await performWrites(db, actorUserId, accountId, input, true);
  } catch (error) {
    // A refusal this service already knows how to name is the answer, even from inside the
    // rehearsal: the re-run preconditions run in the same statement order here as they do in the
    // real transaction, so a target that became ineligible between the two stages is ineligible,
    // not unprocessable. Only a fault the service cannot classify is the rehearsal's own.
    if (error instanceof DeidentificationError || error instanceof OperatorActorError) {
      throw error;
    }

    logger.error("deidentify_rehearsal_failed", {
      code: sqlStateOf(error),
      constraint: constraintNameOf(error),
    });

    throw new DeidentificationError(
      "deidentify_rehearsal_failed",
      500,
      "Penghapusan tidak dapat diproses. Tidak ada data yang diubah. Laporkan ke tim teknis.",
    );
  }

  // From the rehearsal, never from the pre-read. The pre-read answers "may this be the target" and
  // is a stage earlier than the writes; what the bucket is listed for is what the writes resolved,
  // and the gap between the two is where a registration can be created (LAUNCH-D104).
  const prefixes = deidentificationObjectPrefixes({
    userId: accountId,
    registrations: rehearsal.registrations,
    personalInstitutionId: rehearsal.personalInstitutionId,
  });

  let objectsDeleted: number;

  try {
    objectsDeleted = await deleteObjectsUnder(prefixes);
  } catch (error) {
    const deleted = error instanceof StorageDeletionFailure ? error.objectsDeleted : 0;

    throw new DeidentificationError(
      "deidentify_storage_failed",
      502,
      `Sebagian berkas gagal dihapus (${deleted} berkas sudah terhapus). Jalankan lagi untuk menyelesaikan.`,
    );
  }

  const outcome = await performWrites(db, actorUserId, accountId, input, false);

  logger.info(ACCOUNT_DEIDENTIFIED_EVENT, {
    accountId,
    actorUserId,
    objectsDeleted,
    personalInstitutionId: outcome.personalInstitutionId,
  });

  return { objectsDeleted, personalInstitutionId: outcome.personalInstitutionId };
};
