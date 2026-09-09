// @vitest-environment node

// PER ROW, NOT PER COUNT.
//
// The property the deploy gate needs is that the database applied exactly these migrations, in this
// order, from these files. Counting rows and comparing the first and last timestamp — which is what
// the investigation preceding this check did — passes for a database whose middle 58 migrations
// belong to somebody else, and passes for a .sql file edited after it was applied. Both are things
// that have actually happened in this repository.
//
// The accepted-divergence cases are the ones worth reading twice: two migration files were edited
// after being applied, deliberately, and the check has to keep watching them rather than look away.

import { describe, expect, it } from "vitest";
import {
  ACCEPTED_DIVERGENCES,
  compareAppliedToJournal,
  readJournalMigrations,
  type AcceptedDivergence,
  type JournalMigration,
} from "@/server/db/schema-drift";

const entry = (index: number, hash: string, when = 1000 + index): JournalMigration => ({
  index,
  tag: `00${index}_fixture`,
  whenMillis: when,
  hash,
});

const applied = (hash: string, createdAtMillis: number) => ({ hash, createdAtMillis });

describe("compareAppliedToJournal", () => {
  it("reports nothing when every row matches", () => {
    const journal = [entry(0, "aaa"), entry(1, "bbb")];

    expect(
      compareAppliedToJournal(journal, [applied("aaa", 1000), applied("bbb", 1001)], []),
    ).toEqual([]);
  });

  it("catches a file edited after it was applied, in the middle of the history", () => {
    // The exact case a count-and-endpoints comparison cannot see: same number of rows, same first
    // and last timestamp, different SQL in position 1.
    const journal = [entry(0, "aaa"), entry(1, "bbb"), entry(2, "ccc")];
    const rows = [applied("aaa", 1000), applied("SOMETHING_ELSE", 1001), applied("ccc", 1002)];

    const problems = compareAppliedToJournal(journal, rows, []);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.index).toBe(1);
    expect(problems[0]?.problem).toMatch(/does not match the file's/);
  });

  it("catches a database that is behind the checkout", () => {
    const journal = [entry(0, "aaa"), entry(1, "bbb")];

    const problems = compareAppliedToJournal(journal, [applied("aaa", 1000)], []);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.index).toBe(1);
    expect(problems[0]?.problem).toMatch(/never applied/);
  });

  it("catches a database that is ahead of the checkout", () => {
    const journal = [entry(0, "aaa")];

    const problems = compareAppliedToJournal(
      journal,
      [applied("aaa", 1000), applied("zzz", 1001)],
      [],
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.index).toBe(1);
    expect(problems[0]?.problem).toMatch(/absent from the journal/);
  });

  it("catches the same SQL applied from a different journal", () => {
    // A rebase or cherry-pick that renumbered history: the hash still matches, the timestamp does
    // not, and only the timestamp can tell.
    const journal = [entry(0, "aaa", 1000)];

    const problems = compareAppliedToJournal(journal, [applied("aaa", 999)], []);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toMatch(/applied from a different journal/);
  });

  it("reports every divergence, not only the first", () => {
    // "Migration 1 does not match" and "the database is behind" are different operator actions.
    const journal = [entry(0, "aaa"), entry(1, "bbb"), entry(2, "ccc")];

    expect(
      compareAppliedToJournal(journal, [applied("aaa", 1000), applied("XXX", 1001)], []),
    ).toHaveLength(2);
  });
});

describe("accepted divergences", () => {
  const accepted: AcceptedDivergence[] = [
    { index: 1, tag: "001_fixture", legacyHash: "OLD", reason: "edited after it was applied" },
  ];

  it("accepts the pinned pre-edit hash", () => {
    const journal = [entry(0, "aaa"), entry(1, "bbb")];

    expect(
      compareAppliedToJournal(journal, [applied("aaa", 1000), applied("OLD", 1001)], accepted),
    ).toEqual([]);
  });

  it("accepts the current file's hash too, for a database built from zero", () => {
    const journal = [entry(0, "aaa"), entry(1, "bbb")];

    expect(
      compareAppliedToJournal(journal, [applied("aaa", 1000), applied("bbb", 1001)], accepted),
    ).toEqual([]);
  });

  it("STILL FAILS on a third hash, so the row is pinned rather than skipped", () => {
    // The difference between a declared exception and a hole. Skipping the index would make the
    // two most-edited migrations in the repository permanently unwatchable.
    const journal = [entry(0, "aaa"), entry(1, "bbb")];

    const problems = compareAppliedToJournal(
      journal,
      [applied("aaa", 1000), applied("A_THIRD_VALUE", 1001)],
      accepted,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toMatch(/matches neither it nor the current file/);
  });

  it("does not let one migration's exception excuse another's drift", () => {
    const journal = [entry(0, "aaa"), entry(1, "bbb")];

    const problems = compareAppliedToJournal(
      journal,
      [applied("OLD", 1000), applied("bbb", 1001)],
      accepted,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.index).toBe(0);
  });
});

describe("the declared divergences", () => {
  it("names the two migrations 8206ec4 edited after they were applied, and no others", () => {
    // Every entry here is a place the strict comparison is relaxed, so the list is part of the
    // declaration and growing it must be a deliberate, reviewed act.
    expect(ACCEPTED_DIVERGENCES.map((d) => d.tag)).toEqual([
      "0032_eager_cerise",
      "0047_glorious_tiger_shark",
    ]);
  });

  it("pins a full-length hash and a reason for each", () => {
    for (const divergence of ACCEPTED_DIVERGENCES) {
      expect(divergence.legacyHash, divergence.tag).toMatch(/^[0-9a-f]{64}$/);
      expect(divergence.reason.length, divergence.tag).toBeGreaterThan(20);
    }
  });

  it("points at journal entries that actually exist, at the index it claims", () => {
    // An index or tag that drifted from the journal would silently stop matching, turning the
    // exception into a no-op and the migration back into an unexplained failure.
    const journal = readJournalMigrations("drizzle");

    for (const divergence of ACCEPTED_DIVERGENCES) {
      expect(journal[divergence.index]?.tag, `index ${divergence.index}`).toBe(divergence.tag);
    }
  });
});

describe("readJournalMigrations", () => {
  it("hashes every declared migration in the real journal", () => {
    const journal = readJournalMigrations("drizzle");

    expect(journal).toHaveLength(60);
    expect(journal[0]?.index).toBe(0);
    expect(journal[59]?.index).toBe(59);
    for (const migration of journal) {
      expect(migration.hash, migration.tag).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses a journal whose file is missing rather than reporting nothing to compare", () => {
    expect(() => readJournalMigrations("scripts/testing/fixtures/journal-missing-sql")).toThrow(
      /has no file at/,
    );
  });
});
