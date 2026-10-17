/**
 * Renders the Index and Seeded Decisions tables of `decision-log.md` from the decision files.
 *
 * Run:    node --import tsx scripts/project/decisions-build.ts [--docs <dir>]
 * Verify: node --import tsx scripts/project/decisions-build.ts --check [--docs <dir>]
 *
 * `--check` writes nothing and exits 1 when the log on disk differs from a fresh render. Any
 * refusal exits 1 too, because a log that cannot be rendered is not a log that can be trusted.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DECISIONS_DIR_IN_DOCS,
  DECISION_LOG_IN_DOCS,
  DecisionRefusal,
  readDecisionDirectory,
  renderDecisionLog,
} from "./decision-files";

const docsDirectory = (argv: string[]): string => {
  const at = argv.indexOf("--docs");
  if (at === -1) return "docs";
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--"))
    throw new DecisionRefusal("--docs", "needs a directory");
  return value;
};

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
    const [first] = problems;
    if (first !== undefined) {
      throw new DecisionRefusal(
        first.subject,
        `${first.reason} (${problems.length} unreadable file(s); run decisions:check)`,
      );
    }
    const logPath = join(docs, DECISION_LOG_IN_DOCS);
    const onDisk = readFileSync(logPath, "utf8");
    const fresh = renderDecisionLog(onDisk, files);

    if (fresh === onDisk) {
      console.log(`decisions:build  ${logPath} is up to date (${files.length} files)`);
      return;
    }
    if (check) {
      console.error(
        `FAIL: ${logPath} differs from a fresh build, first at ${firstDifference(onDisk, fresh)}`,
      );
      process.exit(1);
    }
    writeFileSync(logPath, fresh);
    console.log(`decisions:build  rewrote ${logPath} (${files.length} files)`);
  } catch (error) {
    if (!(error instanceof DecisionRefusal)) throw error;
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
};

main();
