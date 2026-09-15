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
 * present. The live-catalog half is confirmed separately, in the demonstration, by querying
 * `pg_constraint` — the schema module says what the migrations should have produced, the catalog
 * says what the database will enforce, and the two are compared rather than assumed equal.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/server/db/schema";

/** Drizzle stores the SQL table name under this symbol, not on a typed property. */
const TABLE_NAME = Symbol.for("drizzle:Name");

/** The `ON DELETE` actions Postgres recognises, lowercased as Drizzle writes them. */
export type ReferentialAction =
  | "cascade"
  | "set null"
  | "set default"
  | "restrict"
  | "no action";

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

/** Why a store survives a deletion, in the categories the procedure has to distinguish. */
export type SurvivalReason =
  /** Removed by the CASCADE closure from `users`. Not a survivor. */
  | "removed"
  /**
   * The row survives because its link to the deleted user is SEVERED rather than cascaded.
   *
   * Two shapes produce that, and they need different code to see. A foreign key that nulls is the
   * obvious one. The other is a table with no foreign key to `users` at all, whose only path from
   * `users` runs through an intermediate row the deletion removes — `institutions` is the worked
   * case, anchored by `institution_memberships` and by nothing else. The FK graph can state the
   * second shape (the path exists) but cannot state that it MATTERS, because the severing happens
   * to a row the table does not reference. A survival ruling is therefore a judgement, and this
   * category is where the judgement that a tenant outlives its last member belongs.
   */
  | "detached"
  /** A NO ACTION/RESTRICT edge points here from a surviving row: the delete FAILS. */
  | "blocks-deletion"
  /** Survives and carries nothing attributable to the deleted user. */
  | "holds-no-user-data";

/**
 * One store's ruling: where it is, what the deletion does to it, and why.
 *
 * `carries` names the personal data that outlives the deletion, verbatim from the column list, so a
 * reader can tell a survivor holding an email address from one holding a foreign key and nothing
 * else. An empty list on a `detached` or `blocks-deletion` store is a claim, and the test below
 * checks it against the table's actual columns rather than trusting the prose.
 */
export type StoreRuling = {
  store: string;
  survival: SurvivalReason;
  carries: readonly string[];
  reason: string;
};

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
      const target = reference.foreignTable as unknown as Record<symbol, string>;

      const targetTable = target[TABLE_NAME];
      if (targetTable === undefined) {
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
 * A NO ACTION or RESTRICT edge from a table outside the CASCADE closure, pointing at a table inside
 * it, means a dependent row turns `DELETE FROM users` into a referential-integrity violation. The
 * statement is atomic, so the outcome is not a half-deleted account: it is a refusal with nothing
 * written. That distinction is the difference between a procedure that can be run against a live
 * request and one that cannot, and it is why this set is computed rather than described.
 *
 * Both endpoints of the edge matter and only one of them is obvious. `finance_payments.payer_user_id
 * -> users` blocks when the payer is the deleted user. `finance_payments.competition_registration_id
 * -> competition_registrations` blocks when the deleted user held the registration that payment is
 * for — which is a different person's ledger row standing in the way, and would be missed by a rule
 * that only looked at columns named for a user.
 */
export const blockingForeignKeys = (
  keys = schemaForeignKeys(),
  removed = new Set(cascadeClosure("users", keys)),
): ForeignKey[] =>
  keys
    .filter((key) => key.onDelete === "no action" || key.onDelete === "restrict")
    .filter((key) => removed.has(key.targetTable) && !removed.has(key.sourceTable))
    .sort((a, b) => a.sourceTable.localeCompare(b.sourceTable));

/** The foreign keys that null a pointer instead of taking the row with them. */
export const detachingForeignKeys = (
  keys = schemaForeignKeys(),
  removed = new Set(cascadeClosure("users", keys)),
): ForeignKey[] =>
  keys
    .filter((key) => key.onDelete === "set null")
    .filter((key) => removed.has(key.targetTable) && !removed.has(key.sourceTable))
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
    reachedBy: "the user id in the prefix; the key in `user_profiles` is the exact form, and that "
      + "row is inside the closure, so the key must be read before the delete",
    reason: "profile photo, keyed by the owning user",
  },
  {
    prefix: "banners/{userId}/",
    reachedByDeletion: true,
    scope: "user",
    module: "src/server/user-profile/profile-files-service.ts",
    keyColumns: ["user_profiles.banner_r2_key"],
    reachedBy: "the user id in the prefix, or the key in `user_profiles` — closure row, read it first",
    reason: "profile banner, keyed by the owning user; the institution owner's banner also renders "
      + "on their institution's public page",
  },
  {
    prefix: "resumes/{userId}/",
    reachedByDeletion: true,
    scope: "user",
    module: "src/server/user-profile/profile-files-service.ts",
    keyColumns: ["user_profiles.resume_r2_key"],
    reachedBy: "the user id in the prefix, or the key in `user_profiles` — closure row, read it first",
    reason: "CV, keyed by the owning user",
  },
  {
    prefix: "profile-certifications/{userId}/",
    reachedByDeletion: true,
    scope: "user",
    module: "src/server/user-profile/profile-files-service.ts",
    keyColumns: ["profile_certifications.file_r2_key"],
    reachedBy: "the user id in the prefix, or the key on each `profile_certifications` row — closure "
      + "rows, so a prefix listing under the user id is the only route that survives deleting first",
    reason: "certification scans, keyed by the owning user",
  },
  {
    prefix: "recruiter-verification/{userId}/{submissionId}/",
    reachedByDeletion: true,
    scope: "user",
    module: "src/server/recruiter-verification/recruiter-verification-service.ts",
    keyColumns: ["recruiter_verification_documents.r2_key"],
    reachedBy: "the user id in the prefix, or the key on each document row — closure rows, and the "
      + "submissionId segment is not recorded anywhere else once they are gone",
    reason: "identity documents a recruiter uploaded to verify; the most sensitive objects here",
  },
  {
    prefix: "submissions/{competitionId}/{registrationId}/",
    reachedByDeletion: true,
    scope: "registration",
    module: "src/server/submissions/submission-service.ts",
    keyColumns: ["competition_submissions.file_key"],
    reachedBy: "the key on the submission row — a closure row — or a prefix listing, which needs "
      + "the competition id and the registration id read before either row is deleted",
    reason: "competition entry files; keyed by registration, reached through the user's registration",
  },
  {
    prefix: "registration-documents/{competitionId}/{registrationId}/{requestId}/",
    reachedByDeletion: true,
    scope: "registration",
    module: "src/server/registration-documents/registration-document-service.ts",
    keyColumns: ["competition_document_request_files.r2_key"],
    reachedBy: "the key on each file row — closure rows — or a prefix listing, which needs the "
      + "request ids read before the rows that carry them are deleted",
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
    reachedBy: "the key on the proof row — which DEC-0133 forbids deleting, so the objects are "
      + "exactly addressable AND permanently undeletable by a procedure that respects the ledger",
    reason: "bukti transfer images; the key is recorded on rows that survive, which is what makes "
      + "them reachable and what makes them impossible to remove",
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
    reachedBy: "nothing — institution-scoped; the rows survive a user deletion and so do the objects",
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
    address: "rl:identify: · rl:login-fail: · rl:register: · rl:register-resend-ip: · "
      + "rl:verify-email-addr: · rl:mfa:",
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
 * rather than entering the enumeration unmarked. `removed` entries carry no `carries`: a table the
 * closure deletes leaves nothing behind.
 */
export const TABLE_RULINGS: readonly StoreRuling[] = Object.freeze([
  // ---- removed by the CASCADE closure from `users` ------------------------------------------
  ...[
    "accounts",
    "candidate_profiles",
    "competition_document_request_files",
    "competition_document_requests",
    "competition_registrations",
    "competition_results",
    "competition_reviews",
    "competition_saves",
    "competition_submissions",
    "institution_memberships",
    "mfa_factors",
    "mfa_recovery_codes",
    "notifications",
    "platform_ops_notes",
    "profile_certifications",
    "profile_educations",
    "profile_experiences",
    "profile_skills",
    "profile_social_links",
    "recruiter_verification_documents",
    "recruiter_verification_submissions",
    "sessions",
    "team_invitations",
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
    carries: [] as readonly string[],
    reason: "reached by the CASCADE closure from `users`; the row does not survive the statement",
  })),

  // ---- survive because a NO ACTION edge points at a removed table ----------------------------
  {
    store: "finance_payments",
    survival: "blocks-deletion",
    carries: ["payer_user_id"],
    reason:
      "DEC-0133 makes the ledger append-only, so this row cannot be deleted and must not be " +
      "updated. A candidate who has paid therefore cannot be deleted at all under the current " +
      "schema; the statement fails and nothing is written",
  },
  {
    store: "finance_payment_events",
    survival: "blocks-deletion",
    carries: ["actor_user_id", "metadata"],
    reason:
      "append-only ledger. `metadata` is free-form JSON whose contents are not constrained, so " +
      "whether it carries personal data depends on what the writer put there",
  },
  {
    store: "finance_fee_disclosure_acknowledgements",
    survival: "blocks-deletion",
    carries: ["acknowledged_by_user_id"],
    reason:
      "records that an institution's owner acknowledged a fee rule; the acknowledging user is " +
      "named and the row is part of the fee record",
  },
  {
    store: "finance_manual_payment_proofs",
    survival: "blocks-deletion",
    carries: ["submitted_by_user_id", "r2_key", "original_file_name"],
    reason:
      "the bukti transfer review artifact. The row names the submitter and points at a transfer " +
      "image in R2; the policy §5 keeps transfer evidence as a financial record, so its survival " +
      "is stated to the user rather than accidental",
  },
  {
    store: "finance_manual_payment_proof_attempts",
    survival: "blocks-deletion",
    carries: ["submitted_by_user_id", "reviewer_user_id", "r2_key", "original_file_name"],
    reason:
      "append-only history of every transfer attempt including rejected ones; carries the " +
      "attempting user and the file they sent",
  },
  {
    store: "platform_ops_audit_logs",
    survival: "blocks-deletion",
    carries: ["actor_user_id", "target_user_id", "metadata"],
    reason:
      "the operator action log. Rule 7 requires these rows, so they survive; `metadata` is " +
      "free-form and its contents decide what personal data the row actually carries",
  },
  {
    store: "finance_fee_accruals",
    survival: "blocks-deletion",
    carries: [],
    reason:
      "what an institution owes the platform. Reached through `payment_id` rather than through a " +
      "user column, so it blocks a deletion only when the deleted user's registration is the " +
      "subject of the payment",
  },

  // ---- survive because a SET NULL edge detaches them -----------------------------------------
  {
    store: "competitions",
    survival: "detached",
    carries: ["title", "description", "eligibility_note", "cancellation_reason"],
    reason:
      "`created_by_user_id` nulls; the competition belongs to its institution and outlives the " +
      "staff member who drafted it. What survives with it is everything they WROTE on it — and " +
      "the title is enough on its own. A recruiter's personal competition survives a deletion " +
      "still titled `Kuis Mingguan Rina`, published and publicly reachable, carrying a given " +
      "name that appears nowhere in the account's own rows",
  },
  {
    store: "institution_audit_logs",
    survival: "detached",
    carries: ["metadata"],
    reason:
      "`actor_user_id` nulls, so the log keeps the action and loses who took it. `metadata` is " +
      "free-form and is not cleared",
  },
  {
    store: "institution_invitations",
    survival: "detached",
    carries: ["invited_email"],
    reason:
      "SURVIVOR CARRYING AN IDENTIFIER THE USER CANNOT REACH. `target_user_id` nulls, but " +
      "`invited_email` is a plain column and stays — so deleting an invited person leaves their " +
      "email address in the inviting institution's invitation list",
  },
  {
    store: "institution_verification_audit",
    survival: "detached",
    carries: [],
    reason: "`actor_user_id` nulls; the audit of the institution's verification survives",
  },
  {
    store: "institution_verification_submissions",
    survival: "detached",
    carries: [],
    reason:
      "`submitted_by_user_id` and `reviewer_user_id` null; the institution's own legal documents " +
      "and proposed display name are institution data, not the submitter's",
  },
  {
    store: "institution_verification_documents",
    survival: "holds-no-user-data",
    carries: [],
    reason:
      "child of `institution_verification_submissions`; the institution's legal documents, with " +
      "no user column of its own",
  },

  // ---- survive and hold nothing attributable to the deleted user ------------------------------
  {
    store: "competition_prizes",
    survival: "holds-no-user-data",
    carries: [],
    reason: "child of `competitions`, which survives; it has no user column of its own",
  },
  {
    store: "competition_rounds",
    survival: "holds-no-user-data",
    carries: [],
    reason: "child of `competitions`, which survives; it has no user column of its own",
  },
  {
    store: "competition_tags",
    survival: "holds-no-user-data",
    carries: [],
    reason: "child of `competitions`, which survives; it has no user column of its own",
  },
  {
    store: "institutions",
    survival: "detached",
    carries: [
      "slug",
      "description",
      "about",
      "contact_name",
      "contact_email",
      "contact_phone",
    ],
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
    store: "institution_payment_instructions",
    survival: "holds-no-user-data",
    carries: [],
    reason: "the institution's bank details and QRIS key, not a person's",
  },
  {
    store: "institution_social_links",
    survival: "holds-no-user-data",
    carries: [],
    reason: "the institution's own social links, with no user column of their own",
  },
  {
    store: "finance_fee_rules",
    survival: "holds-no-user-data",
    carries: [],
    reason: "the institution's agreed rate; no user column",
  },
  {
    store: "finance_payment_instruction_snapshots",
    survival: "holds-no-user-data",
    carries: [],
    reason:
      "the bank details a payer was SHOWN at the time, captured so a later change cannot rewrite " +
      "what they were told. Institution data: bank name, account number and account holder",
  },
  {
    store: "verification_tokens",
    survival: "holds-no-user-data",
    carries: [],
    reason:
      "the Auth.js adapter table. It is populated only for flows that pass an explicit identifier " +
      "and holds no `user_id` column at all, so no row is attributable to a user by key",
  },
  {
    store: "infrastructure_probe",
    survival: "holds-no-user-data",
    carries: [],
    reason: "the connector probe's own scratch row; no user column",
  },
]);

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

/** Whether a ruling's `carries` names a column the table actually has. */
export const unknownCarriedColumns = (
  ruling: StoreRuling,
  columnsByTable: ReadonlyMap<string, readonly string[]>,
): string[] => {
  const columns = columnsByTable.get(ruling.store);
  if (columns === undefined) return [...ruling.carries];
  return ruling.carries.filter((column) => !columns.includes(column));
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
