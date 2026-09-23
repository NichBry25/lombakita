/**
 * Every store holding data attributable to one user, derived rather than listed.
 *
 * WHY THIS IS A DERIVATION AND NOT A TABLE OF CONTENTS. A hand-written list of "the places a user's
 * data lives" is correct on the day it is written and silently incomplete on every day after. The
 * privacy policy commits to honouring deletion requests by hand (TRUST-D12); a procedure built on a
 * stale list deletes what the list remembers and reports success over what it forgot. So the
 * population here is computed from the schema and the source tree, and the only hand-written part
 * is the RULING applied to each member — which is a judgement about what the deletion *should*
 * reach, and is exactly the part a reader needs to be able to see and disagree with.
 *
 * WHAT "DERIVED" MEANS, mechanically:
 *
 *  - Postgres. `getTableConfig` over every exported Drizzle table yields the table's name and each
 *    foreign key's source columns, target table and `ON DELETE` action. That graph is walked, not
 *    read: the CASCADE closure from `users` is the set of tables `DELETE FROM users` actually
 *    removes, and the NO ACTION/SET NULL edges that point INTO that closure are the ones that
 *    decide whether the statement fails or detaches instead. Nothing in that computation is written
 *    down in advance, so a table added next month is in the answer the moment it is in the schema.
 *  - Outside Postgres. The R2 surface is derived from the call sites that mint a presigned PUT,
 *    because the prefix a store uses is a property of the code that writes it and not of a list.
 *    The remaining stores (Meilisearch, Redis, BullMQ, Resend, Sentry) have no call-site shape that
 *    identifies them, so they are DECLARED, and the declaration carries the reason it is complete.
 *
 * WHAT IT REFUSES. A derived member with no ruling is a refusal, not a skip (Rule 38). Skipping it
 * is fail-open in the precise sense that matters here: the census would keep printing a confident
 * enumeration whose coverage had shrunk, and the disappearance would be visible only to someone who
 * already knew the table existed.
 *
 * Pure apart from reading the source tree, so the derivation is unit-testable with no database
 * present. That purity is also this module's boundary: the schema module is the SINGLE source, and
 * the live catalog is never consulted. `schema.ts` says what the migrations should have produced;
 * `pg_constraint` says what the database will enforce; nothing here compares them, so a divergence
 * between the two — a constraint altered by hand, a migration that did not land, a table created in
 * raw SQL and absent from the module — is invisible to every claim this file makes. The enumeration
 * describes a schema, not a database.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getTableName } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/server/db/schema";

/** The `ON DELETE` actions Postgres recognises, lowercased as Drizzle writes them. */
export type ReferentialAction = "cascade" | "set null" | "set default" | "restrict" | "no action";

/** One foreign key, as the schema declares it. */
export type ForeignKey = {
  sourceTable: string;
  sourceColumns: readonly string[];
  targetTable: string;
  /**
   * The referenced columns on `targetTable`, positionally paired with `sourceColumns`.
   *
   * Carried because the residue verifier has to WRITE the join, not just read the edge: a count of
   * what a deletion left behind is a join from `users` outwards, and a join needs both ends.
   */
  targetColumns: readonly string[];
  onDelete: ReferentialAction;
};

/**
 * The column classification: which of a table's text-capable columns can hold a person's own data.
 *
 * WHY THIS REPLACED A PER-TABLE RULING (LAUNCH-D100). A table's "holds no user data" was a hand
 * ruling, and eight of the ten it carried were wrong: `competition_prizes` was ruled clean while
 * holding `title`, `description` and `rank_label`, and `institution_verification_documents` was
 * ruled clean while holding `original_file_name`. The ruling was not lazy — it was answering a
 * question about the foreign-key graph ("does anything here point at a user") and printing the
 * answer as a claim about COLUMNS. This module now answers the column question from the columns.
 *
 * TEXT-CAPABLE means one of a fixed set of SQL types: `text`, `varchar`, `char`, `citext`, `json`,
 * `jsonb`, or an array of any of those. Nothing else is classified, and that narrowness is the
 * point — an enum column holds a token from a set the migration wrote, and `boolean` and
 * `timestamptz` hold values a person cannot type. The predicate reads `getSQLType()`, so a column
 * added next month is in the population the moment it is in the schema.
 *
 * POPULATION RULE, applied one column at a time. A column is `personal` when a person can type into
 * it, when it is copied from a field a person typed into, or when it identifies or describes a
 * natural person — names, email addresses, phone numbers, free text (titles, descriptions, notes),
 * URLs, file names, account numbers and account holders, slugs, and Auth.js identifiers. It is
 * `not-personal` only when the application alone generates its value AND that value cannot carry a
 * person's input: ids it mints, hashes, MIME types, storage keys composed only of ids, currency
 * codes, machine-readable status and action tokens, and the provider's own OAuth vocabulary.
 * Where the answer was not clear the column is `personal`, because the two errors are not
 * symmetrical: calling a personal column clean leaves data behind and reports success, while
 * calling a clean column personal costs a line in a listing.
 *
 * WHAT THIS REFUSES. A text-capable column with no classification is a refusal, not a skip (Rule
 * 38). A classification naming a column that does not exist, or that is not text-capable, is a
 * refusal too: it is a claim about a column the schema does not have, and a listing that keeps it
 * reads as coverage.
 *
 * This is the SINGLE source for both derived claims the census makes about a table — whether it
 * holds any user data at all, and which of a person's columns can survive a deletion. Neither is
 * listed anywhere by hand.
 */

/** One text-capable column, addressed by its table and its column name. */
export type TextCapableColumn = { table: string; column: string };

/**
 * The SQL types whose values are text, in the sense this classification is about.
 *
 * `json` and `jsonb` are here rather than excluded because both store text: an email address inside
 * a JSON blob is as present as one in a column of its own.
 */
const TEXT_CAPABLE_SQL_TYPES = new Set(["text", "varchar", "char", "citext", "json", "jsonb"]);

/** The element type of an array, or the type itself when it is not an array. */
const columnElementType = (sqlType: string): string =>
  sqlType.endsWith("[]") ? sqlType.slice(0, -2) : sqlType;

/** Whether a declared SQL type is one of the text-capable types, directly or as an array of one. */
export const isTextCapableSqlType = (sqlType: string): boolean =>
  TEXT_CAPABLE_SQL_TYPES.has(columnElementType(sqlType));

/** Every text-capable column of every schema table, as `table.column` references. */
export const schemaTextCapableColumns = (): TextCapableColumn[] => {
  const columns: TextCapableColumn[] = [];

  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);

    for (const column of config.columns) {
      if (!isTextCapableSqlType(column.getSQLType())) continue;
      columns.push({ table: config.name, column: column.name });
    }
  }

  return columns;
};

/** One column's classification. */
export type ColumnClassification =
  | { column: string; kind: "personal" }
  | { column: string; kind: "not-personal"; reason: string };

/** A `not-personal` classification, which owes the reason it is not personal. */
export type NotPersonalColumn = { column: string; reason: string };

/**
 * Every text-capable column that can carry a person's own data, as `table.column`.
 *
 * Pinned by the test that reads it in BOTH directions, so the population and the classification are
 * one list rather than two that happen to agree today: a column added to the schema without an entry
 * here fails the suite, and an entry naming a column the schema does not have fails it too.
 */
export const PERSONAL_COLUMNS: readonly string[] = Object.freeze([
  // accounts
  "accounts.refresh_token",
  "accounts.access_token",
  "accounts.id_token",
  "accounts.session_state",
  "accounts.provider_account_id",
  // candidate_profiles
  "candidate_profiles.full_name",
  "candidate_profiles.phone_number",
  // competition_document_request_files
  "competition_document_request_files.original_file_name",
  // competition_document_requests
  "competition_document_requests.title",
  "competition_document_requests.instructions",
  "competition_document_requests.review_note",
  // competition_prizes
  "competition_prizes.rank_label",
  "competition_prizes.title",
  "competition_prizes.description",
  // competition_registrations
  "competition_registrations.internal_notes",
  // competition_results
  "competition_results.result_label",
  "competition_results.result_notes",
  // competition_reviews
  "competition_reviews.body",
  // competition_rounds
  "competition_rounds.title",
  "competition_rounds.description",
  "competition_rounds.platform_label",
  // competition_submissions
  "competition_submissions.file_name",
  // competition_tags
  "competition_tags.tag",
  // competitions
  "competitions.slug",
  "competitions.title",
  "competitions.description",
  "competitions.eligibility_note",
  // finance_fee_accruals
  "finance_fee_accruals.reason",
  // finance_manual_payment_proof_attempts
  "finance_manual_payment_proof_attempts.original_file_name",
  "finance_manual_payment_proof_attempts.verdict_reason",
  // finance_manual_payment_proofs
  "finance_manual_payment_proofs.original_file_name",
  "finance_manual_payment_proofs.rejection_reason",
  // finance_payment_events
  "finance_payment_events.reason",
  "finance_payment_events.metadata",
  // finance_payment_instruction_snapshots
  "finance_payment_instruction_snapshots.bank_name",
  "finance_payment_instruction_snapshots.account_number",
  "finance_payment_instruction_snapshots.account_holder_name",
  "finance_payment_instruction_snapshots.instructions_note",
  // institution_audit_logs
  "institution_audit_logs.metadata",
  // institution_invitations
  "institution_invitations.invited_email",
  // institution_payment_instructions
  "institution_payment_instructions.bank_name",
  "institution_payment_instructions.account_number",
  "institution_payment_instructions.account_holder_name",
  "institution_payment_instructions.instructions_note",
  // institution_social_links
  "institution_social_links.url",
  // institution_verification_audit
  "institution_verification_audit.reason",
  // institution_verification_documents
  "institution_verification_documents.original_file_name",
  // institution_verification_submissions
  "institution_verification_submissions.proposed_display_name",
  "institution_verification_submissions.reviewer_notes",
  // institutions
  "institutions.display_name",
  "institutions.slug",
  "institutions.description",
  "institutions.rejection_reason",
  "institutions.suspension_reason",
  "institutions.about",
  "institutions.contact_name",
  "institutions.contact_email",
  "institutions.contact_phone",
  "institutions.website_url",
  // notifications
  "notifications.title",
  "notifications.body",
  // platform_ops_audit_logs
  "platform_ops_audit_logs.reason",
  "platform_ops_audit_logs.metadata",
  // platform_ops_notes
  "platform_ops_notes.note",
  // profile_certifications
  "profile_certifications.name",
  "profile_certifications.issuer",
  "profile_certifications.credential_id",
  "profile_certifications.credential_url",
  "profile_certifications.file_name",
  // profile_educations
  "profile_educations.school",
  "profile_educations.degree",
  "profile_educations.field_of_study",
  "profile_educations.description",
  // profile_experiences
  "profile_experiences.title",
  "profile_experiences.organization_name",
  "profile_experiences.location",
  "profile_experiences.description",
  // profile_skills
  "profile_skills.name",
  // profile_social_links
  "profile_social_links.url",
  // recruiter_verification_documents
  "recruiter_verification_documents.original_file_name",
  // recruiter_verification_submissions
  "recruiter_verification_submissions.full_name",
  "recruiter_verification_submissions.mobile_number",
  "recruiter_verification_submissions.corporate_email",
  "recruiter_verification_submissions.rejection_reason",
  // sessions
  "sessions.session_token",
  // team_invitations
  "team_invitations.invited_email",
  // teams
  "teams.name",
  // user_profiles
  "user_profiles.display_name",
  "user_profiles.phone_number",
  "user_profiles.avatar_url",
  "user_profiles.summary",
  "user_profiles.location",
  "user_profiles.resume_file_name",
  // users
  "users.name",
  "users.email",
  "users.image",
  "users.username",
  "users.suspension_reason",
  // verification_tokens
  "verification_tokens.identifier",
  "verification_tokens.token",
]);

export const NOT_PERSONAL_COLUMNS: readonly NotPersonalColumn[] = Object.freeze([
  // accounts
  { column: "accounts.user_id", reason: "an app-minted id; nothing a person typed reaches it" },
  {
    column: "accounts.type",
    reason: "the Auth.js account type code (`oauth` / `email` / `credentials`)",
  },
  { column: "accounts.provider", reason: "the Auth.js provider slug (`google`)" },
  {
    column: "accounts.token_type",
    reason: "the OAuth token-type token the provider returned (`bearer`)",
  },
  { column: "accounts.scope", reason: "the OAuth scope string the provider returned" },
  // candidate_profiles
  {
    column: "candidate_profiles.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // competition_document_request_files
  {
    column: "competition_document_request_files.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_document_request_files.request_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_document_request_files.r2_key",
    reason: "a storage key composed only of ids",
  },
  {
    column: "competition_document_request_files.content_type",
    reason: "a MIME type the upload declared; it names a format, not a person",
  },
  // competition_document_requests
  {
    column: "competition_document_requests.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_document_requests.registration_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_document_requests.requested_by_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_document_requests.reviewed_by_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // competition_prizes
  {
    column: "competition_prizes.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_prizes.competition_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // competition_registrations
  {
    column: "competition_registrations.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_registrations.competition_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_registrations.student_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_registrations.team_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_registrations.cancellation_reason",
    reason: "the machine-readable cancellation token (`institution_cancelled`)",
  },
  // competition_results
  {
    column: "competition_results.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_results.registration_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_results.competition_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // competition_reviews
  {
    column: "competition_reviews.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_reviews.competition_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_reviews.author_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // competition_rounds
  {
    column: "competition_rounds.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_rounds.competition_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // competition_saves
  {
    column: "competition_saves.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_saves.competition_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // competition_submissions
  {
    column: "competition_submissions.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_submissions.registration_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competition_submissions.submitted_by_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  { column: "competition_submissions.file_key", reason: "a storage key composed only of ids" },
  {
    column: "competition_submissions.file_mime_type",
    reason: "a MIME type the upload declared; it names a format, not a person",
  },
  // competition_tags
  {
    column: "competition_tags.competition_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // competitions
  { column: "competitions.id", reason: "an app-minted id; nothing a person typed reaches it" },
  {
    column: "competitions.institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competitions.created_by_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "competitions.cancellation_reason",
    reason:
      "the machine-readable cancellation token (`insufficient_participants`, pinned by competitions_cancellation_state_chk)",
  },
  { column: "competitions.fee_currency", reason: "a currency code from the fixed ISO set" },
  // finance_fee_accruals
  {
    column: "finance_fee_accruals.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_fee_accruals.payment_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_fee_accruals.owing_institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  { column: "finance_fee_accruals.currency", reason: "a currency code from the fixed ISO set" },
  {
    column: "finance_fee_accruals.fee_rule_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // finance_fee_disclosure_acknowledgements
  {
    column: "finance_fee_disclosure_acknowledgements.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_fee_disclosure_acknowledgements.competition_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_fee_disclosure_acknowledgements.institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_fee_disclosure_acknowledgements.acknowledged_by_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_fee_disclosure_acknowledgements.fee_rule_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_fee_disclosure_acknowledgements.fee_currency",
    reason: "a currency code from the fixed ISO set",
  },
  // finance_fee_rules
  { column: "finance_fee_rules.id", reason: "an app-minted id; nothing a person typed reaches it" },
  {
    column: "finance_fee_rules.institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  { column: "finance_fee_rules.currency", reason: "a currency code from the fixed ISO set" },
  // finance_manual_payment_proof_attempts
  {
    column: "finance_manual_payment_proof_attempts.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_manual_payment_proof_attempts.proof_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_manual_payment_proof_attempts.payment_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_manual_payment_proof_attempts.competition_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_manual_payment_proof_attempts.submitted_by_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_manual_payment_proof_attempts.r2_key",
    reason: "a storage key composed only of ids",
  },
  {
    column: "finance_manual_payment_proof_attempts.content_type",
    reason: "a MIME type the upload declared; it names a format, not a person",
  },
  {
    column: "finance_manual_payment_proof_attempts.reviewer_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // finance_manual_payment_proofs
  {
    column: "finance_manual_payment_proofs.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_manual_payment_proofs.payment_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_manual_payment_proofs.competition_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_manual_payment_proofs.submitted_by_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  { column: "finance_manual_payment_proofs.r2_key", reason: "a storage key composed only of ids" },
  {
    column: "finance_manual_payment_proofs.content_type",
    reason: "a MIME type the upload declared; it names a format, not a person",
  },
  {
    column: "finance_manual_payment_proofs.reviewer_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // finance_payment_events
  {
    column: "finance_payment_events.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_payment_events.payment_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  { column: "finance_payment_events.currency", reason: "a currency code from the fixed ISO set" },
  {
    column: "finance_payment_events.actor_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_payment_events.idempotency_key",
    reason: "the idempotency key the writer minted from the event's own identity",
  },
  // finance_payment_instruction_snapshots
  {
    column: "finance_payment_instruction_snapshots.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_payment_instruction_snapshots.payment_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_payment_instruction_snapshots.qris_r2_key",
    reason: "a storage key composed only of ids",
  },
  // finance_payments
  { column: "finance_payments.id", reason: "an app-minted id; nothing a person typed reaches it" },
  {
    column: "finance_payments.payer_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_payments.receiving_institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "finance_payments.competition_registration_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  { column: "finance_payments.currency", reason: "a currency code from the fixed ISO set" },
  {
    column: "finance_payments.fee_rule_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // infrastructure_probe
  {
    column: "infrastructure_probe.key",
    reason: "the probe's own key from a fixed set the connector list defines",
  },
  // institution_audit_logs
  {
    column: "institution_audit_logs.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_audit_logs.institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_audit_logs.actor_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_audit_logs.action",
    reason: "the machine-readable action code (`membership.invited`)",
  },
  {
    column: "institution_audit_logs.target_membership_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // institution_invitations
  {
    column: "institution_invitations.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_invitations.institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_invitations.token_hash",
    reason: "a hash of a secret the application minted; the secret itself is never stored",
  },
  {
    column: "institution_invitations.invited_by_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_invitations.target_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // institution_memberships
  {
    column: "institution_memberships.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_memberships.institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_memberships.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_memberships.invited_by_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // institution_payment_instructions
  {
    column: "institution_payment_instructions.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_payment_instructions.institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_payment_instructions.qris_r2_key",
    reason: "a storage key composed only of ids",
  },
  // institution_social_links
  {
    column: "institution_social_links.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_social_links.institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // institution_verification_audit
  {
    column: "institution_verification_audit.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_verification_audit.institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_verification_audit.actor_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // institution_verification_documents
  {
    column: "institution_verification_documents.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_verification_documents.submission_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_verification_documents.document_type",
    reason: "the machine-readable document kind code",
  },
  {
    column: "institution_verification_documents.r2_key",
    reason: "a storage key composed only of ids",
  },
  {
    column: "institution_verification_documents.content_type",
    reason: "a MIME type the upload declared; it names a format, not a person",
  },
  // institution_verification_submissions
  {
    column: "institution_verification_submissions.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_verification_submissions.institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_verification_submissions.submitted_by_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "institution_verification_submissions.reviewer_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // institutions
  { column: "institutions.id", reason: "an app-minted id; nothing a person typed reaches it" },
  { column: "institutions.logo_r2_key", reason: "a storage key composed only of ids" },
  { column: "institutions.banner_r2_key", reason: "a storage key composed only of ids" },
  // mfa_factors
  { column: "mfa_factors.id", reason: "an app-minted id; nothing a person typed reaches it" },
  { column: "mfa_factors.user_id", reason: "an app-minted id; nothing a person typed reaches it" },
  {
    column: "mfa_factors.encrypted_secret",
    reason: "ciphertext the server minted for the TOTP secret; no person types into it",
  },
  { column: "mfa_factors.secret_iv", reason: "the initialisation vector for that ciphertext" },
  { column: "mfa_factors.secret_auth_tag", reason: "the authentication tag for that ciphertext" },
  // mfa_recovery_codes
  {
    column: "mfa_recovery_codes.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "mfa_recovery_codes.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "mfa_recovery_codes.code_hash",
    reason: "a hash of a secret the application minted; the secret itself is never stored",
  },
  // notifications
  { column: "notifications.id", reason: "an app-minted id; nothing a person typed reaches it" },
  {
    column: "notifications.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  { column: "notifications.type", reason: "the machine-readable notification type" },
  // platform_ops_audit_logs
  {
    column: "platform_ops_audit_logs.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "platform_ops_audit_logs.actor_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "platform_ops_audit_logs.target_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "platform_ops_audit_logs.target_institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  { column: "platform_ops_audit_logs.event_type", reason: "the machine-readable event code" },
  // platform_ops_notes
  {
    column: "platform_ops_notes.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "platform_ops_notes.target_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "platform_ops_notes.target_institution_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "platform_ops_notes.created_by_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // profile_certifications
  {
    column: "profile_certifications.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "profile_certifications.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  { column: "profile_certifications.file_r2_key", reason: "a storage key composed only of ids" },
  {
    column: "profile_certifications.file_mime_type",
    reason: "a MIME type the upload declared; it names a format, not a person",
  },
  // profile_educations
  {
    column: "profile_educations.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "profile_educations.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // profile_experiences
  {
    column: "profile_experiences.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "profile_experiences.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // profile_skills
  { column: "profile_skills.id", reason: "an app-minted id; nothing a person typed reaches it" },
  {
    column: "profile_skills.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // profile_social_links
  {
    column: "profile_social_links.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "profile_social_links.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // recruiter_verification_documents
  {
    column: "recruiter_verification_documents.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "recruiter_verification_documents.submission_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "recruiter_verification_documents.r2_key",
    reason: "a storage key composed only of ids",
  },
  {
    column: "recruiter_verification_documents.content_type",
    reason: "a MIME type the upload declared; it names a format, not a person",
  },
  // recruiter_verification_submissions
  {
    column: "recruiter_verification_submissions.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "recruiter_verification_submissions.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "recruiter_verification_submissions.reviewer_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // sessions
  { column: "sessions.user_id", reason: "an app-minted id; nothing a person typed reaches it" },
  // team_invitations
  { column: "team_invitations.id", reason: "an app-minted id; nothing a person typed reaches it" },
  {
    column: "team_invitations.team_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "team_invitations.invited_by_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "team_invitations.token_hash",
    reason: "a hash of a secret the application minted; the secret itself is never stored",
  },
  {
    column: "team_invitations.target_user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // team_memberships
  { column: "team_memberships.id", reason: "an app-minted id; nothing a person typed reaches it" },
  {
    column: "team_memberships.team_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "team_memberships.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // teams
  { column: "teams.id", reason: "an app-minted id; nothing a person typed reaches it" },
  { column: "teams.competition_id", reason: "an app-minted id; nothing a person typed reaches it" },
  { column: "teams.captain_id", reason: "an app-minted id; nothing a person typed reaches it" },
  // user_email_verification_tokens
  {
    column: "user_email_verification_tokens.id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "user_email_verification_tokens.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "user_email_verification_tokens.token_hash",
    reason: "a hash of a secret the application minted; the secret itself is never stored",
  },
  // user_password_credentials
  {
    column: "user_password_credentials.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  {
    column: "user_password_credentials.password_hash",
    reason: "a hash of a secret the application minted; the secret itself is never stored",
  },
  // user_platform_roles
  {
    column: "user_platform_roles.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  // user_profiles
  {
    column: "user_profiles.user_id",
    reason: "an app-minted id; nothing a person typed reaches it",
  },
  { column: "user_profiles.avatar_r2_key", reason: "a storage key composed only of ids" },
  { column: "user_profiles.banner_r2_key", reason: "a storage key composed only of ids" },
  { column: "user_profiles.resume_r2_key", reason: "a storage key composed only of ids" },
  {
    column: "user_profiles.resume_mime_type",
    reason: "a MIME type the upload declared; it names a format, not a person",
  },
  // users
  { column: "users.id", reason: "an app-minted id; nothing a person typed reaches it" },
]);

/** The classifications, as one list, in table order. */
export const COLUMN_CLASSIFICATIONS: readonly ColumnClassification[] = Object.freeze([
  ...PERSONAL_COLUMNS.map((column): ColumnClassification => ({ column, kind: "personal" })),
  ...NOT_PERSONAL_COLUMNS.map(
    (entry): ColumnClassification => ({
      column: entry.column,
      kind: "not-personal",
      reason: entry.reason,
    }),
  ),
]);

/** The classification of one `table.column` reference, or `undefined` when it has none. */
export const classifyColumn = (
  reference: string,
  classifications: readonly ColumnClassification[] = COLUMN_CLASSIFICATIONS,
): ColumnClassification | undefined => classifications.find((entry) => entry.column === reference);

/**
 * Text-capable columns with no classification.
 *
 * The refusal's input. Returned as a list rather than thrown from here so the suite can name all of
 * them at once; the deriving path below throws.
 */
export const unclassifiedTextColumns = (
  columns: readonly TextCapableColumn[] = schemaTextCapableColumns(),
  classifications: readonly ColumnClassification[] = COLUMN_CLASSIFICATIONS,
): string[] => {
  const classified = new Set(classifications.map((entry) => entry.column));
  return columns
    .map(({ table, column }) => `${table}.${column}`)
    .filter((reference) => !classified.has(reference));
};

/**
 * Classifications that name a column the schema does not have, or one that is not text-capable.
 *
 * Both are the same defect: a claim about a column that cannot be checked against anything. A
 * renamed column leaves the old entry behind, and the listing keeps counting it as covered.
 */
export const staleColumnClassifications = (
  columns: readonly TextCapableColumn[] = schemaTextCapableColumns(),
  classifications: readonly ColumnClassification[] = COLUMN_CLASSIFICATIONS,
): string[] => {
  const present = new Set(columns.map(({ table, column }) => `${table}.${column}`));
  return classifications
    .map((entry) => entry.column)
    .filter((reference) => !present.has(reference));
};

/** Refuses while any text-capable column is unclassified or any classification is stale. */
export const assertEveryTextColumnIsClassified = (
  columns: readonly TextCapableColumn[] = schemaTextCapableColumns(),
  classifications: readonly ColumnClassification[] = COLUMN_CLASSIFICATIONS,
): void => {
  const unclassified = unclassifiedTextColumns(columns, classifications);
  if (unclassified.length > 0) {
    throw new DeletionCensusRefusal(unclassified.join(", "), "classified column");
  }

  const stale = staleColumnClassifications(columns, classifications);
  if (stale.length > 0) {
    throw new DeletionCensusRefusal(stale.join(", "), "column the schema does not have");
  }

  const unexplained = classifications.filter(
    (entry) => entry.kind === "not-personal" && entry.reason.trim().length === 0,
  );
  if (unexplained.length > 0) {
    throw new DeletionCensusRefusal(
      unexplained.map((entry) => entry.column).join(", "),
      "reason for a not-personal column",
    );
  }
};

/** Every `personal` column of each table, keyed by table name. Tables with none are absent. */
export const personalColumnsByTable = (
  classifications: readonly ColumnClassification[] = COLUMN_CLASSIFICATIONS,
): Map<string, string[]> => {
  assertEveryTextColumnIsClassified(schemaTextCapableColumns(), classifications);

  const byTable = new Map<string, string[]>();

  for (const entry of classifications) {
    if (entry.kind !== "personal") continue;
    const separator = entry.column.indexOf(".");
    const table = entry.column.slice(0, separator);
    const column = entry.column.slice(separator + 1);
    byTable.set(table, [...(byTable.get(table) ?? []), column]);
  }

  return byTable;
};

/** One table's `personal` columns, sorted. Empty when the table holds none. */
export const personalColumnsOf = (table: string): readonly string[] =>
  [...(personalColumnsByTable().get(table) ?? [])].sort();

/**
 * Whether a table holds any user data at all: it holds none exactly when it has no `personal`
 * column.
 *
 * DERIVED, and that is the whole change LAUNCH-D100 asked for. It used to be a hand ruling, and a
 * hand ruling about a table is a hand ruling about the foreign keys that reach it — which is a
 * different question from the one the procedure needs answered. `finance_fee_rules` holds no
 * personal column and is clean; `competition_prizes` holds three and was ruled clean anyway.
 */
export const holdsNoUserData = (table: string): boolean => personalColumnsOf(table).length === 0;

/** Why a store survives a deletion, in the categories the procedure has to distinguish. */
export type SurvivalReason =
  /** Removed by the CASCADE closure from `users`, with nothing of the user's left on it. */
  | "removed"
  /**
   * The row survives the deletion: either the deletion never reaches the table, or a SET NULL edge
   * severs the row's link to the deleted person instead of taking the row with it.
   *
   * WHICH OF THE TWO IS NOT THE INTERESTING PART, and it is why this category no longer has a
   * "holds-no-user-data" sibling. Whether a survivor carries anything is a fact about its COLUMNS,
   * now derived by `carriesOf` rather than asserted here. What remains a judgement is that the row
   * survives at all where the graph alone would not say so — `institutions` is the worked case: it
   * declares no foreign key to `users`, its path from `users` runs through the membership row the
   * deletion removes, and the tenant is left standing with no owner.
   */
  | "detached"
  /** A NO ACTION/RESTRICT edge points here from a surviving row: the delete FAILS. */
  | "blocks-deletion";

/**
 * One store's ruling: where it is, what the deletion does to it, and why.
 *
 * `carries` is not here. What a survivor holds is derived from the column classification by
 * `carriesOf`, so a ruling cannot be right about the row and wrong about the columns on it — which
 * is the exact shape of the eight rulings LAUNCH-D100 found.
 */
export type StoreRuling = {
  store: string;
  survival: SurvivalReason;
  reason: string;
};

/**
 * Whether a row of `table` can still be there — holding whatever it holds — once the statement has
 * finished.
 *
 * THREE WAYS, and each is a property of the edge rather than of the table:
 *
 *  - the deletion never reaches the table at all;
 *  - the row IS reached, but survives because a SET NULL edge severs its link to the person
 *    (`institution_memberships` is the case a per-table reading misses: it is inside the closure,
 *    and one of its pointers still detaches rather than cascades);
 *  - the deletion is REFUSED, by a NO ACTION/RESTRICT edge from this table, so nothing was deleted
 *    and every row is still there.
 *
 * This is the predicate behind `carriesOf`, and it is computed rather than ruled for the same reason
 * the column classification is: the interesting cases are the ones a per-table answer gets wrong.
 */
export const rowsCanOutliveDeletion = (
  table: string,
  keys = schemaForeignKeys(),
  removed = new Set(cascadeClosure("users", keys)),
): boolean =>
  !removed.has(table) ||
  detachingForeignKeys(keys, removed).some((key) => key.sourceTable === table) ||
  blockingForeignKeys(keys, removed).some((key) => key.sourceTable === table);

/**
 * The personal data that outlives a deletion of `table`'s rows, computed from its own columns.
 *
 * Empty for a table whose rows the statement takes with it, and for a survivor that holds no
 * personal column at all — `competition_saves` is the second kind, and its emptiness is a fact about
 * its columns (a user id and a competition id) rather than a claim about the table.
 */
export const carriesOf = (table: string): readonly string[] =>
  rowsCanOutliveDeletion(table) ? personalColumnsOf(table) : [];

/** A derived member the census has no ruling for. Thrown, never returned. */
export class DeletionCensusRefusal extends Error {
  constructor(member: string, kind: string) {
    super(
      `the deletion census has no ruling for ${kind} "${member}". ` +
        `Add a StoreRuling naming what the deletion does to it and what it leaves behind. ` +
        `Refusing rather than omitting it: an unlisted store is one the procedure will not reach, ` +
        `and an enumeration that quietly skips it reads as complete.`,
    );
  }
}

/** Every exported Drizzle table, by SQL name. */
export const schemaTableNames = (): string[] => {
  const names: string[] = [];

  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    names.push(getTableConfig(value).name);
  }

  return names.sort();
};

/** Every foreign key the schema declares, across all tables. */
export const schemaForeignKeys = (): ForeignKey[] => {
  const keys: ForeignKey[] = [];

  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);

    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();

      // A target whose name does not read is REFUSED rather than dropped: a foreign key missing from
      // this graph is a blocker `blockingForeignKeys` will not report, and an enumeration short one
      // edge reads as complete.
      const targetTable = getTableName(reference.foreignTable);
      if (!targetTable) {
        throw new DeletionCensusRefusal(config.name, "foreign key");
      }

      keys.push({
        sourceTable: config.name,
        sourceColumns: reference.columns.map((column) => column.name),
        targetTable,
        targetColumns: reference.foreignColumns.map((column) => column.name),
        onDelete: (foreignKey.onDelete ?? "no action").toLowerCase() as ReferentialAction,
      });
    }
  }

  return keys;
};

/**
 * The tables a `DELETE FROM users` removes, by following CASCADE edges to a fixed point.
 *
 * Direction is the whole content of this function and is easy to get backwards. An edge
 * `accounts.user_id -> users [CASCADE]` means deleting a USERS row deletes ACCOUNTS rows, so the
 * walk starts at `users` and repeatedly adds any table whose CASCADE edge points at a table already
 * in the set. A table that merely REFERENCES a removed table without CASCADE is not added — it is a
 * survivor, and `classifySurvivors` says what happens to it.
 */
export const cascadeClosure = (from = "users", keys = schemaForeignKeys()): string[] => {
  const removed = new Set<string>([from]);
  let grew = true;

  while (grew) {
    grew = false;
    for (const key of keys) {
      if (key.onDelete !== "cascade") continue;
      if (!removed.has(key.targetTable) || removed.has(key.sourceTable)) continue;

      removed.add(key.sourceTable);
      grew = true;
    }
  }

  return [...removed].sort();
};

/**
 * The foreign keys that make the deletion FAIL rather than complete.
 *
 * A NO ACTION or RESTRICT edge pointing at a table inside the closure means a dependent row turns
 * `DELETE FROM users` into a referential-integrity violation — and WHICH table the source sits in
 * does not change that. That was the defect LAUNCH-D105 named: this function used to require the
 * source table to be OUTSIDE the closure, which is a property of a whole table, while Postgres
 * enforces the edge per ROW. `platform_ops_notes` is the row that made it visible — a note the
 * deleted operator wrote has `created_by_id` NOT NULL against a NO ACTION edge, so the statement
 * refuses, and the old filter dropped the edge because the table reaches the closure by way of
 * `target_user_id`.
 *
 * The statement is atomic, so the outcome is not a half-deleted account: it is a refusal with
 * nothing written. That distinction is the difference between a procedure that can be run against a
 * live request and one that cannot, and it is why this set is computed rather than described.
 *
 * Both endpoints of the edge matter and only one of them is obvious. `finance_payments.payer_user_id
 * -> users` blocks when the payer is the deleted user. `finance_payments.competition_registration_id
 * -> competition_registrations` blocks when the deleted user held the registration that payment is
 * for — which is a different person's ledger row standing in the way, and would be missed by a rule
 * that only looked at columns named for a user.
 *
 * WHAT AN ENTRY MEANS is per row, not per table: a row on this edge can refuse the statement. It
 * does not mean every row on it does — a nullable column on the same edge leaves rows that pass.
 * The catalog oracle measures both, constraint by constraint.
 */
export const blockingForeignKeys = (
  keys = schemaForeignKeys(),
  removed = new Set(cascadeClosure("users", keys)),
): ForeignKey[] =>
  keys
    .filter((key) => key.onDelete === "no action" || key.onDelete === "restrict")
    .filter((key) => removed.has(key.targetTable))
    .sort((a, b) => a.sourceTable.localeCompare(b.sourceTable));

/**
 * The foreign keys that null a pointer instead of taking the row with them.
 *
 * The same per-row correction as `blockingForeignKeys`, seen from the other side: whether a given
 * row of the source table is reached has nothing to do with whether the table as a whole is in the
 * closure. A seat on ANOTHER member's `institution_memberships` row survives the deletion of the
 * person who invited them, and that table is in the closure throughout.
 */
export const detachingForeignKeys = (
  keys = schemaForeignKeys(),
  removed = new Set(cascadeClosure("users", keys)),
): ForeignKey[] =>
  keys
    .filter((key) => key.onDelete === "set null")
    .filter((key) => removed.has(key.targetTable))
    .sort((a, b) => a.sourceTable.localeCompare(b.sourceTable));

/**
 * Whether the CASCADE graph contains a cycle through any table.
 *
 * A cycle among CASCADE edges is not an error in Postgres — it resolves the whole strongly connected
 * component at once — but it does mean no single-pass ordering of per-table deletes exists, so a
 * procedure written as a sequence of `DELETE FROM` statements would have to break the cycle by hand.
 * The procedure here issues ONE statement against `users` and lets the engine order the rest, which
 * makes the question moot; it is answered anyway, because "moot" is a claim about the procedure and
 * a reader is entitled to the graph fact behind it.
 */
export const cascadeCycles = (keys = schemaForeignKeys()): string[][] => {
  const cascades = keys.filter((key) => key.onDelete === "cascade");
  const cycles: string[][] = [];

  for (const start of new Set(cascades.map((key) => key.sourceTable))) {
    const stack: string[][] = [[start]];
    const seen = new Set<string>();

    while (stack.length > 0) {
      const path = stack.pop()!;
      const head = path[path.length - 1]!;

      for (const key of cascades) {
        if (key.sourceTable !== head) continue;
        if (key.targetTable === start) {
          cycles.push([...path, start].sort());
          continue;
        }
        if (seen.has(key.targetTable)) continue;
        seen.add(key.targetTable);
        stack.push([...path, key.targetTable]);
      }
    }
  }

  const unique = new Map(cycles.map((cycle) => [cycle.join(">"), cycle]));
  return [...unique.values()];
};

/** A store that is not Postgres, and the reason the deletion does or does not reach it. */
export type ExternalStore = {
  store: string;
  /** The key space, prefix or index the store is addressed by. */
  address: string;
  /** Scoped to one user, one registration, or one institution — what the key carries. */
  scope: "user" | "institution" | "competition" | "registration" | "public";
  reached: boolean;
  reason: string;
};

/**
 * The R2 prefixes, derived from the call sites that mint a presigned PUT.
 *
 * Derived rather than declared because the prefix is a property of the writer. A new upload surface
 * necessarily calls `generatePresignedPutUrl`, so `r2UploadModules` finds it, and
 * `unruledR2Modules` refuses until someone writes down whether the new prefix is user-scoped and
 * where the deletion reaches it. A declared list of prefixes would have kept the census green while
 * a whole new store shipped.
 */
export const r2UploadModules = (root = process.cwd()): string[] => {
  const sourceRoot = resolve(root, "src");
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) continue;
      if (readFileSync(path, "utf8").includes("generatePresignedPutUrl(")) {
        found.push(path.replace(`${root}/`, ""));
      }
    }
  };

  walk(sourceRoot);
  return found.sort();
};

/** One R2 prefix, and what a deletion has to do about it. */
export type R2Prefix = {
  prefix: string;
  scope: "user" | "institution" | "competition" | "registration";
  /** The module whose presigned PUT writes under this prefix. */
  module: string;
  /**
   * Columns holding the exact object key, as `table.column`. Empty when no row records the key, and
   * the objects are then reachable only by listing the prefix.
   *
   * This is what makes the object keys a thing a deletion has to READ BEFORE IT DELETES ANYTHING.
   * Most of these columns live on rows inside the closure, so a procedure that deletes first and
   * lists afterwards has thrown away its own index of what to delete.
   */
  keyColumns: readonly string[];
  /**
   * Whether deleting a user requires these objects to be removed.
   *
   * `false` is not "unimportant" — it is "not the deletion's to remove", and the two reasons are
   * opposite. Institution-scoped objects belong to a tenant that outlives the user. Payment proofs
   * are the ledger's evidence, on rows DEC-0133 forbids deleting, so removing the image would
   * destroy what the surviving row points at.
   *
   * Declared rather than derived from `scope`, because scope and this are different questions: the
   * `payment-proofs` prefix is scoped to a competition and is still not reached.
   */
  reachedByDeletion: boolean;
  /** How a deletion reaches these objects, and what it costs to reach them too late. */
  reachedBy: string;
  reason: string;
};

/**
 * Every R2 prefix the application writes under.
 *
 * Read off the writers rather than off DEC-0066's own row, which states the submission layout as
 * `submissions/{registrationId}/`. That has been wrong since the competition segment was added, and
 * `src/server/submissions/submission-constants.ts` explains why it is load-bearing. A procedure that
 * walked the documented prefix would list zero objects and report success, so the census takes the
 * prefix from the constant the code actually uses.
 */
export const R2_PREFIXES: readonly R2Prefix[] = Object.freeze([
  {
    prefix: "avatars/{userId}/",
    reachedByDeletion: true,
    scope: "user",
    module: "src/server/user-profile/profile-files-service.ts",
    keyColumns: ["user_profiles.avatar_r2_key"],
    reachedBy:
      "the user id in the prefix; the key in `user_profiles` is the exact form, and that " +
      "row is inside the closure, so the key must be read before the delete",
    reason: "profile photo, keyed by the owning user",
  },
  {
    prefix: "banners/{userId}/",
    reachedByDeletion: true,
    scope: "user",
    module: "src/server/user-profile/profile-files-service.ts",
    keyColumns: ["user_profiles.banner_r2_key"],
    reachedBy:
      "the user id in the prefix, or the key in `user_profiles` — closure row, read it first",
    reason:
      "profile banner, keyed by the owning user; the institution owner's banner also renders " +
      "on their institution's public page",
  },
  {
    prefix: "resumes/{userId}/",
    reachedByDeletion: true,
    scope: "user",
    module: "src/server/user-profile/profile-files-service.ts",
    keyColumns: ["user_profiles.resume_r2_key"],
    reachedBy:
      "the user id in the prefix, or the key in `user_profiles` — closure row, read it first",
    reason: "CV, keyed by the owning user",
  },
  {
    prefix: "profile-certifications/{userId}/",
    reachedByDeletion: true,
    scope: "user",
    module: "src/server/user-profile/profile-files-service.ts",
    keyColumns: ["profile_certifications.file_r2_key"],
    reachedBy:
      "the user id in the prefix, or the key on each `profile_certifications` row — closure " +
      "rows, so a prefix listing under the user id is the only route that survives deleting first",
    reason: "certification scans, keyed by the owning user",
  },
  {
    prefix: "recruiter-verification/{userId}/{submissionId}/",
    reachedByDeletion: true,
    scope: "user",
    module: "src/server/recruiter-verification/recruiter-verification-service.ts",
    keyColumns: ["recruiter_verification_documents.r2_key"],
    reachedBy:
      "the user id in the prefix, or the key on each document row — closure rows, and the " +
      "submissionId segment is not recorded anywhere else once they are gone",
    reason: "identity documents a recruiter uploaded to verify; the most sensitive objects here",
  },
  {
    prefix: "submissions/{competitionId}/{registrationId}/",
    reachedByDeletion: true,
    scope: "registration",
    module: "src/server/submissions/submission-service.ts",
    keyColumns: ["competition_submissions.file_key"],
    reachedBy:
      "the key on the submission row — a closure row — or a prefix listing, which needs " +
      "the competition id and the registration id read before either row is deleted",
    reason:
      "competition entry files; keyed by registration, reached through the user's registration",
  },
  {
    prefix: "registration-documents/{competitionId}/{registrationId}/{requestId}/",
    reachedByDeletion: true,
    scope: "registration",
    module: "src/server/registration-documents/registration-document-service.ts",
    keyColumns: ["competition_document_request_files.r2_key"],
    reachedBy:
      "the key on each file row — closure rows — or a prefix listing, which needs the " +
      "request ids read before the rows that carry them are deleted",
    reason: "documents an organiser requested from a participant and the participant uploaded",
  },
  {
    prefix: "payment-proofs/{competitionId}/{paymentId}/",
    reachedByDeletion: false,
    scope: "competition",
    module: "src/server/finance/manual-payment-proof-service.ts",
    keyColumns: [
      "finance_manual_payment_proofs.r2_key",
      "finance_manual_payment_proof_attempts.r2_key",
    ],
    reachedBy:
      "the key on the proof row — which DEC-0133 forbids deleting, so the objects are " +
      "exactly addressable AND permanently undeletable by a procedure that respects the ledger",
    reason:
      "bukti transfer images; the key is recorded on rows that survive, which is what makes " +
      "them reachable and what makes them impossible to remove",
  },
  {
    prefix: "payment-instructions/{institutionId}/",
    reachedByDeletion: false,
    scope: "institution",
    module: "src/server/institutions/payment-instructions-service.ts",
    keyColumns: ["institution_payment_instructions.qris_r2_key"],
    reachedBy: "nothing — institution-scoped, and no user's deletion reaches it",
    reason: "QRIS images; institution-scoped, not user data",
  },
  {
    prefix: "institution-logos/{institutionId}/",
    reachedByDeletion: false,
    scope: "institution",
    module: "src/server/institution-workspace/institution-media-service.ts",
    keyColumns: ["institutions.logo_r2_key"],
    reachedBy: "nothing — institution-scoped, and no user's deletion reaches it",
    reason: "institution logo; institution-scoped",
  },
  {
    prefix: "institution-banners/{institutionId}/",
    reachedByDeletion: false,
    scope: "institution",
    module: "src/server/institution-workspace/institution-media-service.ts",
    keyColumns: ["institutions.banner_r2_key"],
    reachedBy: "nothing — institution-scoped, and no user's deletion reaches it",
    reason: "institution banner; institution-scoped",
  },
  {
    prefix: "verification/{institutionId}/{submissionId}/",
    reachedByDeletion: false,
    scope: "institution",
    module: "src/server/institution-verification/submission-service.ts",
    keyColumns: ["institution_verification_documents.r2_key"],
    reachedBy:
      "nothing — institution-scoped; the rows survive a user deletion and so do the objects",
    reason: "institution legal documents; institution-scoped",
  },
]);

/** R2-writing modules with no declared prefix, which is a refusal. */
export const unruledR2Modules = (modules = r2UploadModules()): string[] => {
  const declared = new Set(R2_PREFIXES.map((entry) => entry.module));
  return modules.filter((module) => !declared.has(module));
};

/** The stores outside Postgres that hold no objects addressable by key. */
export const EXTERNAL_STORES: readonly ExternalStore[] = Object.freeze([
  {
    store: "Cloudflare R2 objects",
    address: "see R2_PREFIXES",
    scope: "user",
    reached: true,
    reason: "reached by prefix listing; the user-scoped prefixes are known, the rest are not",
  },
  {
    store: "Meilisearch index `competitions`",
    address: "documents keyed by competition id",
    scope: "public",
    reached: false,
    reason:
      "carries only published competition fields, plus `institutionOwnerUsername` — the owner's " +
      "username, which survives a deletion and is a personal identifier under UU 27/2022",
  },
  {
    store: "Redis rate-limit counters",
    address:
      "rl:identify: · rl:login-fail: · rl:register: · rl:register-resend-ip: · " +
      "rl:verify-email-addr: · rl:mfa:",
    scope: "user",
    reached: false,
    reason:
      "keyed by IP, or by IP:email, or by user id (rl:mfa:). Fixed-window keys with a TTL of " +
      "minutes, so they lapse on their own; nothing deletes them early and nothing needs to",
  },
  {
    store: "Redis OAuth single-use nonce",
    address: "oauth_carrier_consumed:<jti>",
    scope: "user",
    reached: false,
    reason: "keyed by a random nonce, not by a user; TTL is the carrier's own lifetime",
  },
  {
    store: "Redis MFA elevation grant",
    address: "mfa_elevation_grant:<grantId>",
    scope: "user",
    reached: false,
    reason: "keyed by a random grant id, short TTL; carries no user identifier of its own",
  },
  {
    store: "BullMQ job payloads",
    address: "queues: infrastructure · competition · results · notifications",
    scope: "user",
    reached: false,
    reason:
      "five payload types carry a user id — registration confirmed/cancelled (`studentId`), " +
      "recruiter-verification rejected, registration document requested/reviewed (`userId`) — and " +
      "`payment-proof-submitted` carries `payerDisplayName`. Completed jobs are removed by the " +
      "queue's own retention; nothing in this repository enumerates them",
  },
  {
    store: "Resend message log",
    address: "the provider's own record of messages sent to an address",
    scope: "user",
    reached: false,
    reason:
      "held on the provider's side, outside this system's reach entirely. The policy §6 names " +
      "Resend as receiving the destination address; no deletion path exists from here",
  },
  {
    store: "Sentry events",
    address: "the project's event store",
    scope: "user",
    reached: false,
    reason:
      "error reports, held on the provider's side. Whether an event carries personal data depends " +
      "on what was thrown, and nothing in this repository constrains that",
  },
]);

/**
 * One ruling per table the derivation can produce.
 *
 * Pinned by the test that reads it, so a table added to the schema without a ruling fails the suite
 * rather than entering the enumeration unmarked. What each entry no longer carries is the list of
 * columns that survive with the row — that is `carriesOf`, computed from the table's own columns.
 */
export const TABLE_RULINGS: readonly StoreRuling[] = Object.freeze([
  // ---- rows the statement takes with them ----------------------------------------------------
  ...[
    "accounts",
    "candidate_profiles",
    "competition_document_request_files",
    "competition_registrations",
    "competition_results",
    "competition_reviews",
    "competition_saves",
    "competition_submissions",
    "mfa_factors",
    "mfa_recovery_codes",
    "notifications",
    "profile_certifications",
    "profile_educations",
    "profile_experiences",
    "profile_skills",
    "profile_social_links",
    "recruiter_verification_documents",
    "sessions",
    "team_memberships",
    "teams",
    "user_email_verification_tokens",
    "user_password_credentials",
    "user_platform_roles",
    "user_profiles",
    "users",
  ].map((store) => ({
    store,
    survival: "removed" as const,
    reason:
      "every row reaches `users` through a CASCADE edge, and this table is the source of neither " +
      "a NO ACTION/RESTRICT edge nor a SET NULL edge into the closure — so the statement takes " +
      "every row the deleted user is on, and the rows it leaves are other people's",
  })),

  // ---- rows that survive, and the personal columns still on them -------------------------------
  {
    store: "competition_document_requests",
    survival: "detached",
    reason:
      "IN THE CLOSURE, AND STILL A SURVIVOR — the case a per-table reading drops. A request on " +
      "ANOTHER participant's registration keeps its row when the person who asked for it is " +
      "deleted, because `requested_by_user_id` and `reviewed_by_user_id` are SET NULL. The future " +
      "meant the document is destroyed with the account's own registration; what survives is " +
      "somebody else's registration carrying the requester's `title`, `instructions` and " +
      "`review_note`",
  },
  {
    store: "competition_prizes",
    survival: "detached",
    reason:
      "child of `competitions`, which survives the deletion; nothing reaches it. Its `title`, " +
      "`description` and `rank_label` are the organiser's own words and stay on the row",
  },
  {
    store: "competition_rounds",
    survival: "detached",
    reason:
      "child of `competitions`, which survives; `title`, `description` and `platform_label` stay " +
      "with it",
  },
  {
    store: "competition_tags",
    survival: "detached",
    reason: "child of `competitions`, which survives; `tag` is the organiser's own word",
  },
  {
    store: "competitions",
    survival: "detached",
    reason:
      "`created_by_user_id` nulls; the competition belongs to its institution and outlives the " +
      "staff member who drafted it. What survives with it is everything they WROTE on it — and " +
      "the title is enough on its own. A recruiter's personal competition survives a deletion " +
      "still titled `Kuis Mingguan Rina`, published and publicly reachable, carrying a given " +
      "name that appears nowhere in the account's own rows",
  },
  {
    store: "finance_fee_accruals",
    survival: "detached",
    reason:
      "what an institution owes the platform, reached through `payment_id` and never through a " +
      "user column. Neither of its foreign keys points into the closure, so it cannot block a " +
      "deletion at all — it is listed here because it survives holding whatever `reason` a finance " +
      "operator wrote on the accrual",
  },
  {
    store: "finance_fee_rules",
    survival: "detached",
    reason:
      "the institution's agreed rate. Holds no personal column — an id, an institution id and a " +
      "currency code — so it survives carrying nothing, and `carriesOf` says so from its columns " +
      "rather than from this sentence",
  },
  {
    store: "finance_payment_instruction_snapshots",
    survival: "detached",
    reason:
      "the bank details a payer was SHOWN at the time, captured so a later change cannot rewrite " +
      "what they were told. The bank name, the account number and the account holder are on it and " +
      "they are personal columns; they are the institution's payee details, and nothing in the " +
      "closure reaches the table",
  },
  {
    store: "infrastructure_probe",
    survival: "detached",
    reason:
      "the connector probe's own scratch row. One column, `key`, holding a token from the probe " +
      "list the connector status module defines; no user column and no personal column",
  },
  {
    store: "institution_audit_logs",
    survival: "detached",
    reason:
      "`actor_user_id` nulls, so the log keeps the action and loses who took it. `metadata` is " +
      "free-form JSON and is not cleared — a personal column, because nothing constrains what a " +
      "writer puts in it",
  },
  {
    store: "institution_invitations",
    survival: "detached",
    reason:
      "SURVIVOR CARRYING AN IDENTIFIER THE USER CANNOT REACH. `target_user_id` nulls, but " +
      "`invited_email` is a plain column and stays — so deleting an invited person leaves their " +
      "email address in the inviting institution's invitation list",
  },
  {
    store: "institution_memberships",
    survival: "detached",
    reason:
      "IN THE CLOSURE BY `user_id`, AND STILL A SURVIVOR. The deleted person's own seat cascades " +
      "away, but another member's seat keeps its row when the person who invited them is deleted, " +
      "because `invited_by_user_id` is SET NULL. That surviving row holds no personal column — a " +
      "seat is a user id, an institution id and two enum tokens — so `carriesOf` is empty, and the " +
      "survival is still why the table is not ruled removed",
  },
  {
    store: "institution_payment_instructions",
    survival: "detached",
    reason:
      "the institution's bank details and QRIS key: `bank_name`, `account_number` and " +
      "`account_holder_name` are personal columns, and they belong to the tenant rather than to " +
      "the deleted person. Nothing in the closure reaches the table",
  },
  {
    store: "institution_social_links",
    survival: "detached",
    reason:
      "the institution's own social links; `url` is personal and is the tenant's, not a user's",
  },
  {
    store: "institution_verification_audit",
    survival: "detached",
    reason:
      "`actor_user_id` nulls; the audit of the institution's verification survives holding the " +
      "operator's `reason`, which is free text",
  },
  {
    store: "institution_verification_documents",
    survival: "detached",
    reason:
      "child of `institution_verification_submissions`; the institution's legal documents, ruled " +
      "clean by hand and not clean: `original_file_name` is the uploader's own file name and stays " +
      "on the row",
  },
  {
    store: "institution_verification_submissions",
    survival: "detached",
    reason:
      "`submitted_by_user_id` and `reviewer_user_id` null; the institution's own legal documents, " +
      "its `proposed_display_name` and the reviewer's `reviewer_notes` stay on the row",
  },
  {
    store: "institutions",
    survival: "detached",
    reason:
      "THE TENANT ANCHOR, and the one survivor no foreign key can reach: `institutions` declares NO " +
      "foreign key to `users` at all. Its owner is a membership row, the membership cascades, and " +
      "the institution is left standing with no owner. For an institution whose owner was also its " +
      "only member that is not a tenant outliving a staff member — it is a detachment, and the " +
      "survivor still carries the person: `description` and `about` are free text, the contact " +
      "columns are theirs, and `slug` shares one namespace with usernames. A personal institution " +
      "stores NULL `display_name` and derives its name from the owner's username at read time " +
      "(`getInstitutionDisplayName`), so the row that survives renders as the bare placeholder " +
      "`Personal Institution` — the name is gone and the person is still on the row",
  },
  {
    store: "recruiter_verification_submissions",
    survival: "detached",
    reason:
      "IN THE CLOSURE BY `user_id`, AND STILL A SURVIVOR. The deleted recruiter's own submission " +
      "cascades away; a submission another recruiter made that this person reviewed keeps its row, " +
      "because `reviewer_user_id` is SET NULL. What survives there is the other recruiter's " +
      "identity documents and this person's `rejection_reason`",
  },
  {
    store: "team_invitations",
    survival: "detached",
    reason:
      "IN THE CLOSURE BY `team_id`, AND STILL A SURVIVOR. An invitation sitting on ANOTHER " +
      "captain's team keeps its row when the invited person is deleted: `target_user_id` and " +
      "`invited_by_user_id` are SET NULL and `invited_email` is a plain column. Deleting an " +
      "invited person leaves their email address on the inviting team's list",
  },
  {
    store: "verification_tokens",
    survival: "detached",
    reason:
      "THE SURVIVOR NOTHING REACHES, and both of its columns are personal. It is the Auth.js " +
      "adapter's table: no `user_id` column, no foreign key to `users` anywhere, so no row is " +
      "attributable to anybody by key and the deletion neither nulls nor removes it. Nothing in " +
      "this application writes it — `next-auth` reaches `createVerificationToken` and " +
      '`useVerificationToken` only under `provider.type === "email"`, and this app registers no ' +
      "`EmailProvider` and no `sendVerificationRequest`. So the population is empty, and it is " +
      "empty because no code path writes it rather than because the table is safe: were one row " +
      "ever written, it would hold an email address and a live single-use token that no deletion " +
      "reaches",
  },

  // ---- rows that refuse the statement outright ------------------------------------------------
  {
    store: "finance_payments",
    survival: "blocks-deletion",
    reason:
      "DEC-0133 makes the ledger append-only, so this row cannot be deleted and must not be " +
      "updated. A candidate who has paid therefore cannot be deleted at all under the current " +
      "schema; the statement fails and nothing is written",
  },
  {
    store: "finance_payment_events",
    survival: "blocks-deletion",
    reason:
      "append-only ledger. `metadata` is free-form JSON whose contents are not constrained, so " +
      "whether it carries personal data depends on what the writer put there",
  },
  {
    store: "finance_fee_disclosure_acknowledgements",
    survival: "blocks-deletion",
    reason:
      "records that an institution's owner acknowledged a fee rule; the acknowledging user is " +
      "named on a NOT NULL NO ACTION edge and the row is part of the fee record",
  },
  {
    store: "finance_manual_payment_proofs",
    survival: "blocks-deletion",
    reason:
      "the bukti transfer review artifact. The row names the submitter and points at a transfer " +
      "image in R2; the policy §5 keeps transfer evidence as a financial record, so its survival " +
      "is stated to the user rather than accidental",
  },
  {
    store: "finance_manual_payment_proof_attempts",
    survival: "blocks-deletion",
    reason:
      "append-only history of every transfer attempt including rejected ones; carries the " +
      "attempting user and the file they sent",
  },
  {
    store: "platform_ops_audit_logs",
    survival: "blocks-deletion",
    reason:
      "the operator action log. Rule 7 requires these rows, so they survive; `metadata` is " +
      "free-form and its contents decide what personal data the row actually carries",
  },
  {
    store: "platform_ops_notes",
    survival: "blocks-deletion",
    reason:
      "THE BLOCKER INSIDE THE CLOSURE, and the one a per-table reading drops. A note whose " +
      "`target_user_id` is the deleted person cascades away, so the whole table reads as removed — " +
      "but a note that person WROTE has `created_by_id` NOT NULL against a NO ACTION edge, and " +
      "that row refuses the statement outright. Two rows in one table, and only the second is why " +
      "a platform operator cannot be deleted while their notes are on file",
  },
]);

/** The ruling for one table, or `undefined` when the census has none. */
export const rulingFor = (table: string): StoreRuling | undefined =>
  TABLE_RULINGS.find((ruling) => ruling.store === table);

/**
 * The tables whose personal columns can survive a deletion, with those columns.
 *
 * THE PROCEDURE DOCUMENT'S RESIDUE SECTION IS CHECKED AGAINST THIS. It is what `carriesOf` returns
 * per table, collected: a table appears when a row of it can still be there with a personal column
 * on it, and it is absent either because nothing of it survives or because what survives holds no
 * personal column. Both of those absences are computed from the columns, so a column added to a
 * surviving table appears here without anyone editing a list — and the document test fails until
 * the document says so too.
 */
export const survivingPersonalColumns = (): { table: string; columns: readonly string[] }[] =>
  schemaTableNames()
    .map((table) => ({ table, columns: carriesOf(table) }))
    .filter((entry) => entry.columns.length > 0);

/** Derived members the rulings do not cover, in the order the refusal names them. */
export const unruledTables = (
  derived: readonly string[] = schemaTableNames(),
  rulings: readonly StoreRuling[] = TABLE_RULINGS,
): string[] => {
  const ruled = new Set(rulings.map((ruling) => ruling.store));
  return derived.filter((table) => !ruled.has(table));
};

/** Tables a ruling names that the derivation cannot produce — a stale or misspelled ruling. */
export const rulingsWithoutTable = (
  derived: readonly string[] = schemaTableNames(),
  rulings: readonly StoreRuling[] = TABLE_RULINGS,
): string[] => {
  const present = new Set(derived);
  return rulings.map((ruling) => ruling.store).filter((store) => !present.has(store));
};

/**
 * The rulings grouped by store, so a store carrying two of them can be named.
 *
 * One ruling per store is the shape the census wants: a second entry is either a duplicate or a
 * contradiction, and both read as authority. The grouping exists so the test can print the store
 * rather than the count.
 */
export const rulingsPerStore = (
  rulings: readonly StoreRuling[] = TABLE_RULINGS,
): Map<string, StoreRuling[]> => {
  const grouped = new Map<string, StoreRuling[]>();

  for (const ruling of rulings) {
    grouped.set(ruling.store, [...(grouped.get(ruling.store) ?? []), ruling]);
  }

  return grouped;
};

/**
 * Whether a declared object key names a column the schema actually has.
 *
 * The same staleness a renamed column would leave in `carries`. It matters more here: a column
 * renamed out from under `keyColumns` would leave the procedure reading a key that no longer exists
 * and finding nothing, which reads exactly like a user who uploaded nothing.
 */
export const unknownKeyColumns = (
  entries: readonly R2Prefix[] = R2_PREFIXES,
  columnsByTable: ReadonlyMap<string, readonly string[]> = schemaColumns(),
): string[] =>
  entries.flatMap((entry) =>
    entry.keyColumns.filter((reference) => {
      const separator = reference.indexOf(".");
      if (separator === -1) return true;
      const table = reference.slice(0, separator);
      const column = reference.slice(separator + 1);
      const columns = columnsByTable.get(table);
      return columns === undefined || !columns.includes(column);
    }),
  );

/**
 * Drizzle data types whose SQL value can hold a literal, so a sweep can search inside them.
 *
 * `json` and `array` are here rather than excluded because both are stored as text and both are
 * places a value hides: an email inside a JSON blob is as present as one in a column of its own, and
 * a sweep that skipped them would report the row clean.
 */
const SEARCHABLE_DATA_TYPES = new Set(["string", "json", "array", "buffer"]);

/**
 * Data types whose values are numbers, booleans or instants, which cannot contain a literal.
 *
 * Enumerated rather than left to the fall-through so that the two sets together are exhaustive: a
 * data type in neither set is refused below, where a bare `else` would skip it.
 */
const UNSEARCHABLE_DATA_TYPES = new Set(["number", "boolean", "date", "bigint"]);

/**
 * Every column a value sweep has to search, so that a residue carried as a literal rather than as a
 * reference is found.
 *
 * This exists because an attribution count cannot see a detached row: nulling
 * `institution_invitations.target_user_id` removes the only edge joining the invitation to the
 * person, and the email address on it is then invisible to every join from `users`. A column the
 * census cannot classify throws rather than being skipped — a sweep that silently omits a column
 * reports the same clean result as one that searched it.
 */
export const schemaTextColumns = (): { table: string; column: string }[] => {
  const targets: { table: string; column: string }[] = [];

  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);

    for (const column of config.columns) {
      const dataType = String(column.dataType);

      if (UNSEARCHABLE_DATA_TYPES.has(dataType)) continue;
      if (!SEARCHABLE_DATA_TYPES.has(dataType)) {
        throw new DeletionCensusRefusal(`${config.name}.${column.name}`, "column data type");
      }

      targets.push({ table: config.name, column: column.name });
    }
  }

  return targets;
};

/** Every column of every schema table, by SQL table name. */
export const schemaColumns = (): Map<string, string[]> => {
  const byTable = new Map<string, string[]>();

  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    byTable.set(
      config.name,
      config.columns.map((column) => column.name),
    );
  }

  return byTable;
};
