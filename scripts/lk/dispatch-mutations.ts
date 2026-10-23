/**
 * The mutations of the dispatcher's grant resolution, of its after-run protected path check and of
 * the pin on the old protect script, each with the tests that must turn red for it and no others.
 * A mutated file is run against the test files below in a throwaway copy of scripts/lk; the
 * failures the unmutated copy already has are subtracted.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface DispatcherMutation {
  element: string;
  pattern: RegExp;
  replacement: string;
  /** The file the pattern edits; the default is the dispatcher. */
  path?: string;
  /** Whether the test of this full name must fail under the mutation. */
  redTest: (fullName: string) => boolean;
}

export const DISPATCHER_PATH = "scripts/lk/dispatch.ts";
const PIN_PATH = "scripts/lk/protect-corpus.ts";
const TEST_FILES = ["scripts/lk/dispatch.test.ts", "scripts/lk/protect-corpus.test.ts"];
const COPIED_FOLDERS = ["scripts/lk", "scripts/testing/fixtures/lk"];
const RESOLVED_ENTRY_TEST = "is the real path of each entry";
const DOCS_LINK_TEST = "is spelled below docs/ when docs/ is a link";
const FOLDER_SLASH_TESTS = [
  "is the entries of the grant line joined by colons",
  "accepts the spellings the refusals below have good twins for",
  "hands the session its grant without starting a process",
  RESOLVED_ENTRY_TEST,
  DOCS_LINK_TEST,
];
const LINK_OUT_TEST = "refuses a path through a link to outside the repository";
const CHANGED_SCRIPT_TESTS = ["is refused when one byte differs", "prints no script text"];

const SNAPSHOT_PATH = "scripts/lk/protected-snapshot.ts";
// Every test whose run must end failed because of a protected change carries this phrase.
const CHANGE_FAILS_TEST = "ends failed";
// The tests that need the bytes of a file to be read, either to see them change or to fail on them.
const BYTES_CHANGED_TESTS = [
  "throws for a file it cannot read",
  "names the file in changed, records exit 4",
  "ends failed when the run changes the file ",
  "outside a folder grant",
  "lists only the path no grant covers",
  "committed in the docs repository",
  "rewrites snapshot-before.json",
  "rewrites the grant line of the spec",
  "during the smoke call",
  "own exit 3 and still lists the path",
  "cannot be started after the change",
  "ends failed with exit 4 when the session writes a protected file",
  "exit 3 when the session writes a protected file and fails",
  "writes the snapshot taken before the session and the one taken after it",
  "the sha256 of its bytes",
  "forges a read-only run.json",
  "makes the work folder unwritable",
];
// The tests that need a file below a folder of the set to be seen.
const BELOW_FOLDER_TESTS = [
  "adds a file below the folder ",
  "a file is added under docs/.claude",
  "docs/.claude/seed.txt outside a folder grant",
  "prints one line per path with its kind of change",
  "walks it in sorted order, nested folders included",
  "walks every file of a folder, with no cap",
  "the same session has no grant",
  "adds a sibling of the granted folder",
  "whose mode the session changes",
  "names the file below it",
];
// The tests whose session exits with its own failure code, which the check leaves as it is.
const SESSION_FAILS_ITSELF_TESTS = [
  "own exit 3",
  "cannot be started after the change",
  "exit 3 when the session writes a protected file",
];
// The tests that need a run to end 4 and do not carry the phrase every protected change carries.
const EXIT_4_TESTS = ["records checkError and exits 4", "exits 4 and prints LK RECORD NOT WRITTEN"];

const namedAny = (fragments: readonly string[]) => (fullName: string) =>
  fragments.some((fragment) => fullName.includes(fragment));

const endsAtExit4 = (fullName: string): boolean =>
  !namedAny(SESSION_FAILS_ITSELF_TESTS)(fullName) &&
  namedAny([CHANGE_FAILS_TEST, ...EXIT_4_TESTS])(fullName);

export const DISPATCHER_MUTATIONS: readonly DispatcherMutation[] = [
  {
    element: "the dispatcher resolving each grant entry by realpath",
    pattern: /^ {2}const resolved = realPathOfLongestPrefix\(resolve\(root, entry\)\);$/m,
    replacement: "  const resolved = resolve(realRoot, entry);",
    redTest: namedAny([RESOLVED_ENTRY_TEST, LINK_OUT_TEST]),
  },
  {
    element: "the dispatcher passing the entry as written instead of the resolved path",
    pattern:
      /^ {2}return \{ resolved: entry\.endsWith\("\/"\) \? `\$\{relative\}\/` : relative \};$/m,
    replacement: "  return { resolved: entry };",
    redTest: namedAny([RESOLVED_ENTRY_TEST]),
  },
  {
    element: "the dispatcher keeping the slash of a resolved folder entry",
    pattern:
      /^ {2}return \{ resolved: entry\.endsWith\("\/"\) \? `\$\{relative\}\/` : relative \};$/m,
    replacement: "  return { resolved: relative };",
    redTest: namedAny(FOLDER_SLASH_TESTS),
  },
  {
    element: "the dispatcher spelling a path below docs/ for a linked docs checkout",
    pattern: /^ {4}: join\("docs", belowFolder\(resolved, realDocs\)\);$/m,
    replacement: "    : belowFolder(resolved, realDocs);",
    redTest: namedAny([DOCS_LINK_TEST]),
  },
  {
    element: "the blob id comparison of the old protect script",
    path: PIN_PATH,
    pattern: /^ {2}if \(found !== OLD_PROTECT_BLOB_ID\) \{$/m,
    replacement: "  if (false) {",
    redTest: namedAny(CHANGED_SCRIPT_TESTS),
  },
  {
    element: "the after-run check comparing the two snapshots",
    pattern: /^ {4}const changes = diffSnapshots\(check\.before, after\);$/m,
    replacement: "    const changes: PathChange[] = [];",
    redTest: namedAny([CHANGE_FAILS_TEST]),
  },
  {
    element: "the after-run check taking its first snapshot before the session",
    pattern: /^ {4}const changes = diffSnapshots\(check\.before, after\);$/m,
    replacement:
      "    const changes = diffSnapshots(snapshotProtectedPaths(root, PROTECTED_SET), after);",
    redTest: namedAny([CHANGE_FAILS_TEST]),
  },
  {
    element: "the after-run check letting the grant decide what is covered",
    pattern:
      /^ {2}return entries\.some\(\(entry\) => entryCoversChange\(entry\.toLowerCase\(\), folded\)\);$/m,
    replacement: "  return true;",
    redTest: namedAny([CHANGE_FAILS_TEST]),
  },
  {
    element: "the after-run check hashing the bytes of a file",
    path: SNAPSHOT_PATH,
    pattern:
      /^ {2}if \(stats\.isFile\(\)\) return \{ path, kind: "file", mode, sha256: sha256Of\(absolute\) \};$/m,
    replacement: '  if (stats.isFile()) return { path, kind: "file", mode };',
    redTest: namedAny(BYTES_CHANGED_TESTS),
  },
  {
    element: "the after-run check walking into protected folders",
    path: SNAPSHOT_PATH,
    pattern: /^ {2}if \(entry\.kind !== "folder"\) return;$/m,
    replacement: "  return;",
    redTest: namedAny(BELOW_FOLDER_TESTS),
  },
  {
    element: "the after-run check covering the folder a folder grant names",
    pattern: /^ {2}if \(path === withoutTrailingSlash\(entry\)\) return true;$/m,
    replacement: "",
    redTest: namedAny(["mode of the folder the grant names"]),
  },
  {
    element: "the after-run check covering the folders created to reach a granted path",
    pattern:
      /^ {2}return isCreationOrRemoval && entry\.startsWith\(`\$\{withoutTrailingSlash\(path\)\}\/`\);$/m,
    replacement: "  return false;",
    redTest: namedAny(["with its parent folder missing", "with docs/.claude missing as well"]),
  },
  {
    element: "the after-run check replacing the files it owns in the work folder",
    pattern: /^const writeOwnedFile = \(path: string, text: string\): void => \{\n[\s\S]*?\n\};$/m,
    replacement:
      "const writeOwnedFile = (path: string, text: string): void => {\n  writeFileSync(path, text);\n};",
    redTest: namedAny([
      "links snapshot-after.json to a protected file",
      "links run.json to a protected file",
      "a link sits at snapshot-before.json",
      "forges a read-only run.json",
    ]),
  },
  {
    element: "the after-run check printing a failed step after the session instead of throwing",
    pattern:
      /^ {2}try \{\n {4}step\(\);\n {4}return true;\n {2}\} catch \(error\) \{\n {4}print\(`\$\{notice\}: \$\{messageOf\(error\)\}`\);\n {4}return false;\n {2}\}$/m,
    replacement: "  step();\n  return true;",
    redTest: namedAny([
      "makes the work folder unwritable",
      "LK LOCK NOT REMOVED",
      "when only snapshot-after.json cannot be replaced",
    ]),
  },
  {
    element: "the after-run check watching the product root spellings of the docs files",
    pattern: /^ {2}"CLAUDE\.md",\n {2}"AGENTS\.md",\n {2}"\.claude",\n/m,
    replacement: "",
    redTest: namedAny(["at the product root"]),
  },
  {
    element: "the after-run check taking its first snapshot before the smoke call",
    pattern:
      /^ {4}const before = snapshotBeforeRun\(root, slug\);\n {4}if \(!options\.noSmoke\) \{\n {6}refuseUnlessModelAnswers\(session\.model, \{ cwd: root, env: childEnv \}, deps\.runSmoke\);\n {4}\}$/m,
    replacement:
      "    if (!options.noSmoke) {\n      refuseUnlessModelAnswers(session.model, { cwd: root, env: childEnv }, deps.runSmoke);\n    }\n    const before = snapshotBeforeRun(root, slug);",
    redTest: namedAny([
      "during the smoke call",
      "when the first snapshot cannot be taken",
      "snapshot-before.json cannot be replaced",
    ]),
  },
  {
    element: "the after-run check raising the exit to 4 when the session exited 0",
    pattern: /^ {2}end\.exitCode === 0 \? PROTECTED_CHANGE_EXIT : end\.exitCode;$/m,
    replacement: "  end.exitCode;",
    redTest: endsAtExit4,
  },
  {
    element: "the after-run check recording a second snapshot that cannot be taken",
    pattern: /^ {4}verdict\.checkError = messageOf\(error\);$/m,
    replacement: "",
    redTest: namedAny(["records checkError"]),
  },
];

interface TestResult {
  fullName: string;
  failed: boolean;
}

const NODE_ONLY_VITEST_CONFIG = `export default { test: { environment: "node", include: ${JSON.stringify(TEST_FILES)} } };\n`;

const filesIn = (repoRoot: string, folder: string): string[] =>
  spawnSync("git", ["-C", repoRoot, "ls-files", "--", folder], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((path) => path !== "");

const copyCommittedFolders = (repoRoot: string, treeRoot: string): void => {
  for (const folder of COPIED_FOLDERS) {
    for (const path of filesIn(repoRoot, folder)) {
      const target = join(treeRoot, path);
      if (existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(repoRoot, path), target);
    }
  }
};

/** Runs the test files in the tree against the docs checkout and returns every test with whether it failed. */
export const runDispatcherTests = (
  repoRoot: string,
  treeRoot: string,
  docsRoot: string,
): TestResult[] => {
  copyCommittedFolders(repoRoot, treeRoot);
  writeFileSync(join(treeRoot, "vitest.config.mjs"), NODE_ONLY_VITEST_CONFIG);
  writeFileSync(join(treeRoot, "package.json"), readFileSync(join(repoRoot, "package.json")));
  symlinkSync(join(repoRoot, "node_modules"), join(treeRoot, "node_modules"));
  const outputFile = join(treeRoot, "vitest-results.json");
  const ran = spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules/vitest/vitest.mjs"),
      "run",
      ...TEST_FILES,
      "--config",
      "vitest.config.mjs",
      "--maxWorkers=2",
      "--reporter=json",
      `--outputFile=${outputFile}`,
    ],
    { cwd: treeRoot, encoding: "utf8", env: { ...process.env, DENY_PROOF_DOCS_ROOT: docsRoot } },
  );
  if (ran.error !== undefined) throw ran.error;
  const report = JSON.parse(readFileSync(outputFile, "utf8")) as {
    testResults: { assertionResults: { fullName: string; status: string }[] }[];
  };
  return report.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({
      fullName: test.fullName,
      failed: test.status === "failed",
    })),
  );
};

export interface DispatcherVerdict {
  declared: string[];
  red: string[];
  missing: string[];
  extra: string[];
}

/** Compares the tests the mutation turned red, beyond those already failing, with the tests it declares. */
export const judgeDispatcherMutation = (
  mutation: DispatcherMutation,
  baseline: readonly TestResult[],
  mutated: readonly TestResult[],
): DispatcherVerdict => {
  const alreadyFailing = new Set(
    baseline.filter((test) => test.failed).map((test) => test.fullName),
  );
  const red = mutated
    .filter((test) => test.failed && !alreadyFailing.has(test.fullName))
    .map((test) => test.fullName);
  const declared = baseline.map((test) => test.fullName).filter(mutation.redTest);
  return {
    declared,
    red,
    missing: declared.filter((name) => !red.includes(name)),
    extra: red.filter((name) => !declared.includes(name)),
  };
};
