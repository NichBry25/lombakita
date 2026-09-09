/**
 * Whether a database's applied migrations are exactly the ones this checkout declares.
 *
 * PER ROW, NOT PER COUNT. The investigation that preceded this compared the number of applied rows
 * plus the first and last `created_at`, and said so. That is a strictly weaker property: it passes
 * for a database that applied 60 migrations of which the middle 58 are somebody else's, and it
 * passes for a `.sql` file edited after it was applied, which is the everyday way a schema and its
 * migration history stop agreeing. Drizzle stores a SHA-256 of each file's full contents, so the
 * exact question can be asked and there is no reason to ask a looser one.
 *
 * The hash is computed the way `drizzle-orm/migrator` computes it — `sha256` over the whole `.sql`
 * file, iterated in journal order, with the journal's `when` written as `created_at`. That is read
 * off its source rather than assumed, because a comparison against a hash computed differently
 * would fail identically to real drift and could not be told apart from it.
 *
 * Pure and I/O-free apart from reading the migration folder, so the comparison can be unit-tested
 * against fixtures without a database anywhere near it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type JournalMigration = {
  index: number;
  tag: string;
  whenMillis: number;
  hash: string;
};

/** One row of `drizzle.__drizzle_migrations`, in the order the migrator wrote them. */
export type AppliedMigration = {
  hash: string;
  createdAtMillis: number;
};

export type DriftProblem = {
  index: number;
  tag: string | null;
  problem: string;
};

/**
 * A migration whose applied hash legitimately differs from its file's, with the other hash pinned.
 *
 * `8206ec4` edited two ALREADY-APPLIED migration files so an empty database could be built from
 * zero: 0032 gained the `draft` enum value in its original CREATE TYPE and 0047's ADD VALUE became
 * idempotent. That commit's own message records the reasoning, including that it is safe because
 * "Drizzle decides what is pending by timestamp and never compares the stored hash".
 *
 * So two populations are both correct and always will be. A database migrated before that commit
 * holds `legacyHash`; one built from zero after it holds the current file's hash. Neither is drift.
 *
 * THIS PINS THE OTHER VALUE RATHER THAN SKIPPING THE ROW, which is the whole difference between a
 * declared exception and a hole. An allowlisted index still has to present one of exactly two
 * known hashes; a third value is drift and still fails. Skipping the index would have made these
 * two migrations permanently unwatchable, and they are the two most likely to be edited again.
 *
 * Verified rather than asserted: each `legacyHash` below is the SHA-256 of that file's contents at
 * `8206ec4^`, and each was confirmed equal to the hash `lombakita_production` actually holds.
 */
export type AcceptedDivergence = {
  index: number;
  tag: string;
  legacyHash: string;
  reason: string;
};

export const ACCEPTED_DIVERGENCES: readonly AcceptedDivergence[] = Object.freeze([
  {
    index: 32,
    tag: "0032_eager_cerise",
    legacyHash: "fa6ec2078aab98c3570ee13245a5bd7e58fb96479474015e4618f4f8b3506690",
    reason:
      "8206ec4 added the `draft` value to the original CREATE TYPE so a fresh database has it " +
      "from the start; databases migrated before that commit hold the pre-edit hash",
  },
  {
    index: 47,
    tag: "0047_glorious_tiger_shark",
    legacyHash: "bd41deb99255091242b59aff113fd7c93b5eec2ca5d2b58bca369477ae08a1e5",
    reason:
      "8206ec4 made this migration's ADD VALUE idempotent so it is a no-op on a database that " +
      "already has `draft`; databases migrated before that commit hold the pre-edit hash",
  },
] as const);

const acceptedFor = (
  accepted: readonly AcceptedDivergence[],
  index: number,
  tag: string,
): AcceptedDivergence | undefined =>
  accepted.find((entry) => entry.index === index && entry.tag === tag);

/**
 * The migrations this checkout declares, hashed the way drizzle hashes them.
 *
 * Throws when a journal entry names a file that is not there: a missing `.sql` is drift in its own
 * right, and reporting it as "nothing to compare" would be the fail-open this check exists to stop.
 */
export const readJournalMigrations = (drizzleDir: string): JournalMigration[] => {
  const journalPath = join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries?: { idx: number; tag: string; when: number }[];
  };

  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error(
      `${journalPath} declares no migrations, so there is nothing to compare against`,
    );
  }

  return journal.entries.map((entry) => {
    const sqlPath = join(drizzleDir, `${entry.tag}.sql`);
    let contents: string;

    try {
      contents = readFileSync(sqlPath, "utf8");
    } catch {
      throw new Error(`Journal entry ${entry.idx} (${entry.tag}) has no file at ${sqlPath}`);
    }

    return {
      index: entry.idx,
      tag: entry.tag,
      whenMillis: entry.when,
      hash: createHash("sha256").update(contents).digest("hex"),
    };
  });
};

/**
 * Every way the applied history differs from the declared one.
 *
 * Reports ALL divergences rather than the first, because "migration 12 does not match" and "the
 * database is 3 migrations behind" are different operator actions and seeing only the earlier one
 * hides the other. An empty array means the two agree row for row.
 */
export const compareAppliedToJournal = (
  journal: readonly JournalMigration[],
  applied: readonly AppliedMigration[],
  accepted: readonly AcceptedDivergence[] = ACCEPTED_DIVERGENCES,
): DriftProblem[] => {
  const problems: DriftProblem[] = [];
  const shared = Math.min(journal.length, applied.length);

  for (let index = 0; index < shared; index += 1) {
    const declared = journal[index]!;
    const found = applied[index]!;

    if (declared.hash !== found.hash) {
      const exception = acceptedFor(accepted, index, declared.tag);

      // Exactly two hashes are legitimate here and a third is still drift.
      if (exception && found.hash === exception.legacyHash) {
        continue;
      }

      problems.push({
        index,
        tag: declared.tag,
        problem:
          `applied hash ${found.hash.slice(0, 12)}… does not match the file's ` +
          `${declared.hash.slice(0, 12)}…, so ${declared.tag}.sql has changed since it was applied ` +
          "or a different migration was applied in this position" +
          (exception
            ? `. This migration has a declared pre-edit hash (${exception.legacyHash.slice(0, 12)}…), ` +
              "and the applied value matches neither it nor the current file"
            : ""),
      });
      continue;
    }

    // The hash matching while the timestamp does not means the same SQL arrived from a different
    // journal — a rebase or a cherry-pick that renumbered history.
    if (declared.whenMillis !== found.createdAtMillis) {
      problems.push({
        index,
        tag: declared.tag,
        problem:
          `applied at ${found.createdAtMillis} but the journal records ${declared.whenMillis}; the ` +
          "SQL matches, so this row was applied from a different journal",
      });
    }
  }

  for (let index = shared; index < journal.length; index += 1) {
    problems.push({
      index,
      tag: journal[index]!.tag,
      problem: "declared in the journal but never applied — the database is behind this checkout",
    });
  }

  for (let index = shared; index < applied.length; index += 1) {
    problems.push({
      index,
      tag: null,
      problem:
        `applied (hash ${applied[index]!.hash.slice(0, 12)}…) but absent from the journal — the ` +
        "database is ahead of this checkout, or belongs to a different one",
    });
  }

  return problems;
};
