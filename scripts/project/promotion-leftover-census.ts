/**
 * Every row that ties an account to another person's data, derived rather than listed.
 *
 * THE RULE. An account being promoted to an operator role must not be tied to any other person's
 * data. The promotion procedure refuses such an account and lists what ties it; nothing is deleted.
 *
 * WHY A DERIVATION. The ties are the foreign keys that point INTO `users`. A hand-written list of
 * them is correct on the day it is written and silently short on every day after, and a short list
 * here fails open: the promotion would proceed over a tie the list had forgotten. So the population
 * is computed from the schema, and the only hand-written part is the RULING on each edge: whether a
 * row there is the account's own scaffolding (`allowed`) or a tie to someone else (`blocks`). It is
 * the same shape as `deletion-census.ts`, including its refusal: a derived edge with no ruling is a
 * refusal, not a skip (Rule 38).
 *
 * TWO KINDS OF TIE, and the second is not a foreign key. An invitation can be addressed to an
 * account by email before the account is attached to it, so `invited_email` on the two invitation
 * tables names the account without referencing it. Those columns are DECLARED in
 * `EMAIL_KEYED_ARMS`, and a test asserts the declaration covers every `invited_email` column the
 * schema has.
 *
 * This module renders the two SQL fragments the procedure document embeds. The document is the
 * artifact and this file is where its leftover statements come from, so the document cannot drift
 * from the rulings: a test compares the two byte for byte.
 *
 * Pure apart from reading the schema module. The enumeration describes a schema, not a database.
 */

import { schemaColumns, schemaForeignKeys, type ForeignKey } from "./deletion-census";

export type LeftoverRulingKind = "blocks" | "allowed";

export type LeftoverRuling = {
  table: string;
  column: string;
  ruling: LeftoverRulingKind;
  group: string;
  reason: string;
};

/** A column that names an account by email address instead of referencing it. */
export type EmailKeyedArm = { table: string; column: string };

export const BLOCKING_GROUPS = [
  "competing",
  "institutions",
  "recruiting",
  "money",
  "moderation history",
] as const;

export type BlockingGroup = (typeof BLOCKING_GROUPS)[number];

const BLOCKING_REASONS: Record<BlockingGroup, string> = {
  competing: "ties the account to a competition, team or review record",
  institutions:
    "ties the account to an institution's membership, invitation, audit or verification record",
  recruiting: "ties the account to a recruiter verification submission",
  money: "ties the account to a payment, a proof of payment or its audit trail",
  "moderation history": "ties the account to platform-ops notes or audit rows",
};

const blocks = (group: BlockingGroup, table: string, column: string): LeftoverRuling => ({
  table,
  column,
  ruling: "blocks",
  group,
  reason: BLOCKING_REASONS[group],
});

const allowed = (group: string, reason: string, table: string, column: string): LeftoverRuling => ({
  table,
  column,
  ruling: "allowed",
  group,
  reason,
});

const SCAFFOLDING = "scaffolding";
const SCAFFOLDING_REASON = "the account's own scaffolding";

export const LEFTOVER_RULINGS: readonly LeftoverRuling[] = Object.freeze([
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "user_profiles", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "profile_experiences", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "profile_educations", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "profile_skills", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "profile_certifications", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "profile_social_links", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "user_password_credentials", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "user_email_verification_tokens", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "user_password_reset_tokens", "user_id"),
  allowed(
    SCAFFOLDING,
    "stored role grants. No product code inserts into this table and its only reader is the auth context route. Classified as the account's own scaffolding by the controller, not ruled on by the owner",
    "user_platform_roles",
    "user_id",
  ),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "accounts", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "sessions", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "candidate_profiles", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "mfa_factors", "user_id"),
  allowed(SCAFFOLDING, SCAFFOLDING_REASON, "mfa_recovery_codes", "user_id"),
  allowed("inbox", "owner ruling: the inbox may remain", "notifications", "user_id"),
  allowed("bookmarks", "owner ruling: bookmarks may remain", "competition_saves", "user_id"),

  blocks("competing", "competition_registrations", "student_id"),
  blocks("competing", "teams", "captain_id"),
  blocks("competing", "team_memberships", "user_id"),
  blocks("competing", "team_invitations", "invited_by_user_id"),
  blocks("competing", "team_invitations", "target_user_id"),
  blocks("competing", "competition_submissions", "submitted_by_id"),
  blocks("competing", "competition_reviews", "author_user_id"),
  blocks("competing", "competition_document_requests", "requested_by_user_id"),
  blocks("competing", "competition_document_requests", "reviewed_by_user_id"),

  blocks("institutions", "institution_memberships", "user_id"),
  blocks("institutions", "institution_memberships", "invited_by_user_id"),
  blocks("institutions", "institution_invitations", "invited_by_user_id"),
  blocks("institutions", "institution_invitations", "target_user_id"),
  blocks("institutions", "institution_audit_logs", "actor_user_id"),
  blocks("institutions", "institution_verification_audit", "actor_user_id"),
  blocks("institutions", "institution_verification_submissions", "submitted_by_user_id"),
  blocks("institutions", "institution_verification_submissions", "reviewer_user_id"),
  blocks("institutions", "competitions", "created_by_user_id"),

  blocks("recruiting", "recruiter_verification_submissions", "user_id"),
  blocks("recruiting", "recruiter_verification_submissions", "reviewer_user_id"),

  blocks("money", "finance_payments", "payer_user_id"),
  blocks("money", "finance_manual_payment_proofs", "submitted_by_user_id"),
  blocks("money", "finance_manual_payment_proofs", "reviewer_user_id"),
  blocks("money", "finance_manual_payment_proof_attempts", "submitted_by_user_id"),
  blocks("money", "finance_manual_payment_proof_attempts", "reviewer_user_id"),
  blocks("money", "finance_payment_events", "actor_user_id"),
  blocks("money", "finance_fee_disclosure_acknowledgements", "acknowledged_by_user_id"),

  blocks("moderation history", "platform_ops_notes", "target_user_id"),
  blocks("moderation history", "platform_ops_notes", "created_by_id"),
  blocks("moderation history", "platform_ops_audit_logs", "actor_user_id"),
  blocks("moderation history", "platform_ops_audit_logs", "target_user_id"),
]);

/** Not foreign keys, so declared. A test asserts this covers every `invited_email` in the schema. */
export const EMAIL_KEYED_ARMS: readonly EmailKeyedArm[] = Object.freeze([
  { table: "institution_invitations", column: "invited_email" },
  { table: "team_invitations", column: "invited_email" },
]);

export class PromotionLeftoverRefusal extends Error {
  constructor(edges: readonly string[]) {
    super(
      `the promotion leftover census has no ruling for ${edges.map((edge) => `"${edge}"`).join(", ")}. ` +
        "Add a LeftoverRuling saying whether a row there is the account's own scaffolding or a tie to " +
        "someone else's data. Refusing rather than omitting it: an unruled edge is one the promotion " +
        "will not check, and a procedure that quietly skips it reads as complete.",
    );
  }
}

type Edge = { table: string; column: string };

const edgeName = (edge: Edge): string => `${edge.table}.${edge.column}`;

/** Every foreign-key column that points at `users`, one entry per source column. */
export const derivedLeftoverEdges = (keys: readonly ForeignKey[] = schemaForeignKeys()): Edge[] =>
  keys
    .filter((key) => key.targetTable === "users")
    .flatMap((key) => key.sourceColumns.map((column) => ({ table: key.sourceTable, column })));

/** Derived edges no ruling covers, in the order the refusal names them. */
export const unruledLeftoverEdges = (
  derived: readonly Edge[] = derivedLeftoverEdges(),
  rulings: readonly LeftoverRuling[] = LEFTOVER_RULINGS,
): string[] => {
  const ruled = new Set(rulings.map(edgeName));
  return derived.map(edgeName).filter((name) => !ruled.has(name));
};

/** Rulings that name an edge the derivation cannot produce: a stale or misspelled ruling. */
export const staleLeftoverRulings = (
  derived: readonly Edge[] = derivedLeftoverEdges(),
  rulings: readonly LeftoverRuling[] = LEFTOVER_RULINGS,
): string[] => {
  const present = new Set(derived.map(edgeName));
  return rulings.map(edgeName).filter((name) => !present.has(name));
};

export const blockingRulings = (
  rulings: readonly LeftoverRuling[] = LEFTOVER_RULINGS,
): LeftoverRuling[] => rulings.filter((ruling) => ruling.ruling === "blocks");

const EMAIL_OF_ACCOUNT = "lower(btrim((select email from users where id = $1)))";

const assertEveryEdgeIsRuled = (rulings: readonly LeftoverRuling[]): void => {
  const unruled = unruledLeftoverEdges(derivedLeftoverEdges(), rulings);
  if (unruled.length > 0) throw new PromotionLeftoverRefusal(unruled);
};

/**
 * The union that lists, per source, how many rows tie the account to someone else's data. Sources
 * with no rows are absent. Embedded in the `preconditions` statement.
 */
export const renderLeftoverListingSql = (
  rulings: readonly LeftoverRuling[] = LEFTOVER_RULINGS,
): string => {
  assertEveryEdgeIsRuled(rulings);

  const selects = [
    ...blockingRulings(rulings).map(
      ({ table, column }) =>
        `    select '${table}.${column}' as source, count(*)::int as n from ${table} where ${column} = $1 having count(*) > 0`,
    ),
    ...EMAIL_KEYED_ARMS.map(
      ({ table, column }) =>
        `    select '${table}.${column}' as source, count(*)::int as n from ${table} where ${column} = ${EMAIL_OF_ACCOUNT} having count(*) > 0`,
    ),
  ];

  return selects.join("\n    union all\n");
};

/** The guards that make the promotion match zero rows while a tie exists. Embedded in `promote`. */
export const renderLeftoverAbsentSql = (
  rulings: readonly LeftoverRuling[] = LEFTOVER_RULINGS,
): string => {
  assertEveryEdgeIsRuled(rulings);

  return [
    ...blockingRulings(rulings).map(
      ({ table, column }) => `  and not exists (select 1 from ${table} where ${column} = $1)`,
    ),
    ...EMAIL_KEYED_ARMS.map(
      ({ table, column }) =>
        `  and not exists (select 1 from ${table} where ${column} = ${EMAIL_OF_ACCOUNT})`,
    ),
  ].join("\n");
};

/** The `invited_email` columns the schema declares, for the test that checks the arms are complete. */
export const schemaInvitedEmailColumns = (): EmailKeyedArm[] => {
  const columns: EmailKeyedArm[] = [];
  for (const [table, names] of schemaColumns()) {
    for (const column of names) {
      if (column === "invited_email") columns.push({ table, column });
    }
  }
  return columns.sort((a, b) => edgeName(a).localeCompare(edgeName(b)));
};
