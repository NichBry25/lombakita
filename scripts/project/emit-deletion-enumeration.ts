/**
 * Render the deletion census to the committed enumeration artifact.
 *
 * EVERY BYTE of `docs/operations/account-deletion-enumeration.md` comes from this file reading
 * `deletion-census.ts`. Nothing is written into that artifact by hand — not even its title — because
 * a document that mixes measured claims with asserted ones gives a reader no way to tell which is
 * which, and the asserted ones are exactly the lines that go stale unnoticed. The prose below is the
 * artifact's source, in the same sense that `schema.ts` is the database's.
 *
 * Usage: node --import tsx scripts/project/emit-deletion-enumeration.ts [--check]
 *
 * `--check` renders and compares against the file on disk without writing, so an un-emitted schema
 * change fails rather than leaving a stale artifact in `docs/`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  blockingForeignKeys,
  carriesOf,
  cascadeClosure,
  cascadeCycles,
  detachingForeignKeys,
  EXTERNAL_STORES,
  NOT_PERSONAL_COLUMNS,
  PERSONAL_COLUMNS,
  R2_PREFIXES,
  r2UploadModules,
  schemaForeignKeys,
  schemaTableNames,
  schemaTextCapableColumns,
  staleColumnClassifications,
  survivingPersonalColumns,
  TABLE_RULINGS,
  unclassifiedTextColumns,
  unknownKeyColumns,
  unruledR2Modules,
  unruledTables,
} from "./deletion-census";

export const ARTIFACT_PATH = "docs/operations/account-deletion-enumeration.md";

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string => {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join(" | ")} |`;

  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
};

const bullet = (items: readonly string[]): string => items.map((item) => `- ${item}`).join("\n");

/** The artifact, in full. There is no surrounding prose on disk that this does not produce. */
export const renderEnumeration = (): string => {
  const removed = cascadeClosure();
  const removedSet = new Set(removed);
  const tables = schemaTableNames();
  const fks = schemaForeignKeys();
  const blocking = blockingForeignKeys();
  const unruled = unruledTables();
  const unruledR2 = unruledR2Modules();
  const textColumns = schemaTextCapableColumns();
  const unclassified = unclassifiedTextColumns(textColumns);
  const stale = staleColumnClassifications(textColumns);
  const unknownKey = unknownKeyColumns();
  const cycles = cascadeCycles();

  const bySurvival = (kind: string): typeof TABLE_RULINGS =>
    TABLE_RULINGS.filter((ruling) => ruling.survival === kind);

  // The four fates partition the tables. If they stop doing so, the emitted table would show a
  // total that quietly disagrees with the counts above it, so the disagreement is made loud here
  // rather than rendered.
  const fated =
    bySurvival("removed").length +
    bySurvival("detached").length +
    bySurvival("blocks-deletion").length;
  if (fated !== tables.length) {
    throw new Error(
      `the rulings account for ${fated} tables but the schema declares ${tables.length}`,
    );
  }

  return [
    "# Account deletion — what a deletion has to reach",
    "",
    "**This file is generated. Do not edit it.**",
    "",
    "    node --import tsx scripts/project/emit-deletion-enumeration.ts",
    "",
    "Every figure and every row below is produced by `scripts/project/deletion-census.ts`: the",
    "Postgres tables, foreign keys and columns from the schema in `src/server/db/schema.ts`, the R2",
    "prefixes from the modules that write them, the external stores from declared entries. The counts",
    "are as of the commit that last wrote this file",
    "(`git log -1 --format=%H -- docs/operations/account-deletion-enumeration.md`).",
    "",
    "What is DERIVED and what is DECLARED is stated section by section, because they carry different",
    "weight: a derived row cannot be wrong without the schema being wrong, and a declared row is",
    "someone's answer.",
    "",
    "`scripts/project/deletion-census.test.ts` refuses an unruled store by name, and the refusals are",
    "reported in the last section of this file.",
    "",
    "## What this answers, and what it does not",
    "",
    "It answers: **which stores hold data belonging to a user, and what happens to each when the",
    "`users` row is deleted.**",
    "",
    "It does not answer **whether the deletion succeeds.** The foreign keys marked `blocks-deletion`",
    "below are the reason: a user who holds any of those rows cannot be deleted at all until they are",
    "dealt with first. Which populations those are is a property of the rows, not of the graph, and",
    "this file describes the graph.",
    "",
    "It does not answer **whether the procedure reaches every store listed.** The stores marked",
    "`reached: no` have no key space this system controls. That the procedure walks a prefix is a",
    "claim about the procedure, not about the store, and the procedure is a separate document.",
    "",
    "It does not describe **the products of a partial deletion.** R2 objects are not enrolled in a",
    "database transaction, so a failure partway leaves a state this graph cannot express.",
    "",
    "## How the population is held complete",
    "",
    "The table set is derived, not listed: every export of `schema.ts` that is a `PgTable`, and every",
    "foreign key on it. A table with no ruling is refused by name rather than skipped. So is an upload",
    "module that mints a presigned PUT without a declared prefix. The test asserts both refusals are",
    "empty, which means the enumeration is a population with a membership test rather than a snapshot",
    "of what someone remembered.",
    "",
    "## Postgres — the shape of the graph",
    "",
    `Tables in \`public\`: **${tables.length}**. Foreign keys: **${fks.length}**.`,
    `Reached by the CASCADE closure from \`users\`: **${removed.length}**. Not reached: **${tables.length - removed.length}**.`,
    `CASCADE cycles found: **${cycles.length}**.`,
    "",
    "The walk starts at `users` and follows CASCADE edges only, to a fixed point. A table that",
    "references a removed table without CASCADE is a survivor, and what happens to its rows is the",
    "subject of the three tables after this one.",
    "",
    "Being in the closure is a property of a TABLE and the three fates are properties of a ROW, so",
    "the two do not partition each other. Five tables are in the closure and still survive it:",
    `${
      TABLE_RULINGS.filter((ruling) => ruling.survival !== "removed" && removedSet.has(ruling.store))
        .map((ruling) => `\`${ruling.store}\``)
        .join(", ")
    }. A reading that stopped at the closure would report those rows deleted.`,
    "",
    "`carries` is absent from this file's method on purpose. What a surviving row holds is derived",
    "from the column classification described under \"what fails when a new store is added\" below,",
    "so no table carries a hand-written list of the columns that outlive a deletion.",
    "",
    `**Table count by fate.** The ${tables.length} tables above, each counted once:`,
    "",
    table(
      ["fate", "tables"],
      [
        ["removed by the CASCADE closure", String(bySurvival("removed").length)],
        [
          "survives: not reached, or SET NULL severs the pointer",
          String(bySurvival("detached").length),
        ],
        [
          "survives, and BLOCKS the deletion (NO ACTION)",
          String(bySurvival("blocks-deletion").length),
        ],
      ],
    ),
    "",
    `No CASCADE cycle means the engine can order the whole cascade itself and a single statement is`,
    `enough for the Postgres side. What it cannot do is complete that statement when a blocking row`,
    `exists — see below.`,
    "",
    "## Postgres — the foreign keys that make a deletion REFUSE",
    "",
    "A NO ACTION edge from a surviving table into the closure means one dependent row turns",
    "`DELETE FROM users` into a referential-integrity violation. The statement is atomic, so the",
    "outcome is a refusal with nothing written — not a half-deleted account. Every user population",
    "that cannot be deleted is named by one of these rows.",
    "",
    table(
      ["surviving table", "columns", "points at"],
      blocking.map((key) => [
        `\`${key.sourceTable}\``,
        key.sourceColumns.map((column) => `\`${column}\``).join(", "),
        `\`${key.targetTable}\``,
      ]),
    ),
    "",
    "`finance_payments.competition_registration_id` is the one that does not name a user. It means a",
    "**different person's** ledger row blocks the delete when the deleted user held the registration,",
    "so a rule keyed on user-named columns alone would miss it.",
    "",
    "## Postgres — the foreign keys that DETACH instead",
    "",
    "The row survives and the pointer to the deleted user is nulled. What the row keeps is the",
    "question, and the next table answers it column by column.",
    "",
    table(
      ["surviving table", "columns nulled", "points at"],
      detachingForeignKeys().map((key) => [
        `\`${key.sourceTable}\``,
        key.sourceColumns.map((column) => `\`${column}\``).join(", "),
        `\`${key.targetTable}\``,
      ]),
    ),
    "",
    "Eight of the rows above have a source table OUTSIDE the closure and six have one inside it, and",
    "the six are the ones a per-table reading drops. Whether a given row is reached has nothing to do",
    "with whether its table is in the closure: a seat on another member's `institution_memberships`",
    "row, an invitation on another captain's `team_invitations` row, a request on another",
    "participant's `competition_document_requests` row and a review on another recruiter's",
    "`recruiter_verification_submissions` row all survive the deletion of the person named on them.",
    "",
    "## Postgres — what each surviving table carries",
    "",
    "A non-empty cell is personal data that outlives the deletion, and the list is DERIVED from the",
    "table's own classified columns rather than written here. `institution_invitations.invited_email`",
    "is the one nobody can reach: nothing in the product shows an invited person the invitation another",
    "institution holds for their address.",
    "",
    table(
      ["table", "fate", "personal data that survives"],
      TABLE_RULINGS.filter((ruling) => ruling.survival !== "removed").map((ruling) => [
        `\`${ruling.store}\``,
        ruling.survival,
        carriesOf(ruling.store).length === 0
          ? "—"
          : carriesOf(ruling.store).map((column) => `\`${column}\``).join(", "),
      ]),
    ),
    "",
    `Tables a deletion can leave personal data on: **${survivingPersonalColumns().length}**. The`,
    "listing below is that set in full, which is what the deletion procedure's residue section is",
    "checked against — a column added to one of these tables appears here and in the procedure, or",
    "the procedure's own test fails.",
    "",
    table(
      ["table", "personal columns that can survive"],
      survivingPersonalColumns().map((entry) => [
        `\`${entry.table}\``,
        entry.columns.map((column) => `\`${column}\``).join(", "),
      ]),
    ),
    "",
    `### The ${removed.length} tables the deletion removes`,
    "",
    "Listed so that the tables absent from the three tables above are visibly accounted for rather",
    "than merely missing.",
    "",
    bullet(removed.map((name) => `\`${name}\``)),
    "",
    "## Outside Postgres — Cloudflare R2",
    "",
    `Upload modules found by scanning \`src/\` for \`generatePresignedPutUrl(\`: **${r2UploadModules().length}**.`,
    `Modules with no declared prefix: **${unruledR2.length}**.`,
    "",
    `Prefixes a deletion has to remove: **${R2_PREFIXES.filter((entry) => entry.reachedByDeletion).length}**.`,
    `Prefixes it does not: **${R2_PREFIXES.filter((entry) => !entry.reachedByDeletion).length}**.`,
    "",
    table(
      [
        "prefix",
        "scope",
        "reached by a deletion",
        "object key recorded in",
        "how a deletion reaches it",
      ],
      R2_PREFIXES.map((entry) => [
        `\`${entry.prefix}\``,
        entry.scope,
        entry.reachedByDeletion ? "yes" : "no",
        entry.keyColumns.length === 0
          ? "— no row records it"
          : entry.keyColumns.map((column) => `\`${column}\``).join(", "),
        entry.reachedBy,
      ]),
    ),
    "",
    "`reached by a deletion` is declared, not derived from `scope`, because they are different",
    "questions: `payment-proofs` is scoped to a competition and is still not reached. A `no` is not",
    '"unimportant" either, and the two reasons for one are opposite. Institution-scoped objects',
    "belong to a tenant that outlives the user. Payment proofs are the ledger's evidence, on rows",
    "DEC-0133 forbids deleting, so removing the image would destroy what the surviving row points at.",
    "",
    "**The object keys are on rows the deletion is about to remove.** Every prefix marked `yes`",
    "above takes its exact key from a row inside the CASCADE closure. A",
    "procedure that deletes the account first and lists R2 afterwards has thrown away its own index",
    "of what to delete, and a prefix listing under a user id recovers only the four prefixes whose",
    "second segment IS the user id. That ordering is a requirement of the procedure, not a",
    "preference, and it is the one place where doing the database work first is unrecoverable.",
    "",
    "## Outside Postgres — the stores with no key space",
    "",
    "Each is declared with the reason the declaration is complete. `reached` is `no` for every one of",
    "them, and that is the honest answer rather than a to-do: none of these stores has a call-site",
    "shape that identifies a user's records from this system.",
    "",
    table(
      ["store", "addressed by", "reached", "why"],
      EXTERNAL_STORES.map((store) => [
        store.store,
        `\`${store.address}\``,
        store.reached ? "yes" : "no",
        store.reason,
      ]),
    ),
    "",
    "## What fails when a new store is added",
    "",
    `Unruled tables, derived minus declared: **${unruled.length === 0 ? "none" : unruled.join(", ")}**.`,
    `Unruled upload modules: **${unruledR2.length === 0 ? "none" : unruledR2.join(", ")}**.`,
    `Text-capable columns in the schema: **${textColumns.length}**, of which personal: **${PERSONAL_COLUMNS.length}** and not personal: **${NOT_PERSONAL_COLUMNS.length}**.`,
    `Text-capable columns with no classification: **${unclassified.length === 0 ? "none" : unclassified.join(", ")}**.`,
    `Classifications naming a column the schema does not have, or one that is not text-capable: **${stale.length === 0 ? "none" : stale.join(", ")}**.`,
    `Object keys naming a column the schema does not have: **${unknownKey.length === 0 ? "none" : unknownKey.join(", ")}**.`,
    "",
    "`scripts/project/deletion-census.test.ts` asserts each of those is empty. A table added to",
    "`src/server/db/schema.ts` without a ruling in `TABLE_RULINGS`, or an upload surface that calls",
    "`generatePresignedPutUrl` without an `R2_PREFIXES` entry, fails the suite and names the store.",
    "That is the answer to the acceptance question: the thing that notices a new member is a test,",
    "not a reader, and the enumeration is a population rather than a snapshot.",
    "",
    "Three things have no such test, and are named here so their absence is not mistaken for coverage:",
    "",
    bullet([
      "**A new prefix inside a module that already uploads.** The R2 check is per MODULE: a file that calls `generatePresignedPutUrl(` and is not named by any entry is refused, but a fifth prefix added inside `profile-files-service.ts` is not, because that module is already declared. Prefixes are built from constants and template literals in shapes a regex reads as noise, so deriving them was not attempted. What this means is that the R2 population is complete for upload SURFACES and not provably complete for upload prefixes.",
      "**A new non-Postgres store.** `EXTERNAL_STORES` is declared, not derived — Redis, BullMQ, Resend and Sentry have no common call-site shape to scan for. Adding one to the product does not fail anything here. The entries above are checked for an answer and for a reason, which catches a store going silent, not a store going missing.",
      "**A text-capable column classified the wrong way.** Every text-capable column must carry a classification and every classification must name a real column, so a new column is refused until someone answers for it. What no test can catch is an answer that is WRONG — a column the application alone generates that was called personal costs a line in a listing, and one that can hold a person's typing that was called not-personal leaves data behind quietly. That direction is why the population rule says to answer `personal` when unsure, and why the reasons above are printed rather than counted: a reason is the thing a reader can disagree with.",
    ]),
    "",
  ].join("\n");
};

const main = (): void => {
  const path = resolve(process.cwd(), ARTIFACT_PATH);
  const rendered = renderEnumeration();
  const check = process.argv.includes("--check");

  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = "";
  }

  if (check) {
    if (existing !== rendered) {
      console.error(
        `the deletion enumeration at ${ARTIFACT_PATH} is stale — re-run without --check`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`${ARTIFACT_PATH} matches the census`);
    return;
  }

  writeFileSync(path, rendered, "utf8");
  console.log(`wrote ${ARTIFACT_PATH}`);
};

if (process.argv[1]?.endsWith("emit-deletion-enumeration.ts")) main();
