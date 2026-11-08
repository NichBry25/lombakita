/**
 * Renders the Index table of `decision-log.md` and the Seeded Decisions table of
 * `decision-table.md` from the decision files.
 *
 * Run:    node --import tsx scripts/project/decisions-build.ts [--docs <dir>]
 * Verify: node --import tsx scripts/project/decisions-build.ts --check [--docs <dir>]
 *
 * `--check` writes nothing and exits 1 when either file on disk differs from a fresh render. Any
 * refusal exits 1 too, because a file that cannot be rendered is not a file that can be trusted.
 * Both files are rendered before either is written, so a refusal leaves both untouched.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DECISIONS_DIR_IN_DOCS,
  DECISION_LOG_IN_DOCS,
  DECISION_TABLE_IN_DOCS,
  DecisionRefusal,
  docsDirectory,
  readDecisionDirectory,
  readDecisionLog,
  readDecisionTable,
  refuseStrayDecisionRows,
  refuseUnknownTypes,
  renderDecisionLog,
  renderDecisionTable,
} from "./decision-files";

type GeneratedFile = { path: string; onDisk: string; fresh: string };

/** The first line where the two texts differ, and the decision id on it when it is a table row. */
const firstDifference = (onDisk: string, fresh: string): string => {
  const a = onDisk.split("\n");
  const b = fresh.split("\n");
  const at = a.findIndex((line, index) => line !== b[index]);
  const line = at === -1 ? Math.min(a.length, b.length) : at;
  const id = /^\| ((?:DEC|NOTE)-[^ ]+) \|/.exec(b[line] ?? a[line] ?? "")?.[1];
  return `line ${line + 1}${id === undefined ? "" : ` (${id})`}\n  on disk: ${a[line] ?? "(end of file)"}\n  fresh:   ${b[line] ?? "(end of file)"}`;
};

const main = (): void => {
  const check = process.argv.includes("--check");
  try {
    const docs = docsDirectory(process.argv);
    const { entries, problems } = readDecisionDirectory(join(docs, DECISIONS_DIR_IN_DOCS));
    const files = entries.map((entry) => entry.decision);
    refuseUnknownTypes(entries);
    const [first] = problems;
    if (first !== undefined) {
      throw new DecisionRefusal(
        first.subject,
        `${first.reason} (${problems.length} unreadable file(s); run decisions:check)`,
      );
    }
    const logOnDisk = readDecisionLog(docs);
    const tableOnDisk = readDecisionTable(docs);
    refuseStrayDecisionRows(logOnDisk, tableOnDisk);
    const generated: GeneratedFile[] = [
      {
        path: join(docs, DECISION_LOG_IN_DOCS),
        onDisk: logOnDisk,
        fresh: renderDecisionLog(logOnDisk, files),
      },
      {
        path: join(docs, DECISION_TABLE_IN_DOCS),
        onDisk: tableOnDisk,
        fresh: renderDecisionTable(tableOnDisk, files),
      },
    ];

    let differing = 0;
    for (const { path, onDisk, fresh } of generated) {
      if (fresh === onDisk) {
        console.log(`decisions:build  ${path} is up to date (${files.length} files)`);
        continue;
      }
      if (check) {
        differing += 1;
        console.error(
          `FAIL: ${path} differs from a fresh build, first at ${firstDifference(onDisk, fresh)}`,
        );
        continue;
      }
      writeFileSync(path, fresh);
      console.log(`decisions:build  rewrote ${path} (${files.length} files)`);
    }
    if (differing > 0) process.exit(1);
  } catch (error) {
    if (!(error instanceof DecisionRefusal)) throw error;
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
};

main();
