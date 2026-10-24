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
  "ends done when the file the run changes is below a folder grant",
  "ends done when the session creates the granted folder and a file in it",
  "ends done when the session removes the granted folder",
  "ends failed when the session replaces an existing granted folder with a link",
];
const LINK_OUT_TEST = "refuses a path through a link to outside the repository";
const CHANGED_SCRIPT_TESTS = ["is refused when one byte differs", "prints no script text"];

const SNAPSHOT_PATH = "scripts/lk/protected-snapshot.ts";
const SET_LITERAL_TEST = "is exactly the set the item specified";
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
  "counts a path whose parent is a file as absent",
  "forges a read-only run.json",
  "forges run.json as done and makes the work folder read-only",
  "cannot be replaced after a protected change",
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
  "names the missing ancestor when the session creates it",
  "creates a granted file that does not exist yet as a link",
  "creates a granted folder that does not exist yet as a link",
  "replaces an existing granted folder with a link",
  "merely starts with the name of a granted",
  "holds a newline",
  "holds U+0085",
  "prints one check-failed line",
];
// The tests of a folder above the set that is replaced by a link, has its mode changed or is
// created as a link, and the ones that read what the first snapshot records of such folders.
const FOLDER_ABOVE_SET_TESTS = [
  "a link to a copy of itself",
  "its mode changes",
  "names docs/product with added",
  "writes the folders above the set into snapshot-before.json",
  "records the folders above the paths of the set",
  "refuses a folder above the set and a path of the set that differ only in case",
  "counts a path whose parent is a file as absent",
];
// The tests where a folder grant covers the mode change of the folder it names above the set, and
// the ones where a grant that does not name that folder leaves its change reported.
const GRANT_COVERS_FOLDER_ABOVE_TESTS = ["covers the mode change of"];
const GRANT_LEAVES_FOLDER_ABOVE_REPORTED_TESTS = [
  "names docs/product with changed when a grant names",
  "when its own folder grant is there and it is replaced by a link to a copy of itself",
];
// The tests that print a refusal built from text the session chose, and the one that prints a notice.
const FIFO_REFUSAL_TESTS = [
  "a fifo below docs/.claude named with a newline",
  "a fifo below docs/.claude whose name holds it",
];
const REFUSAL_PRINT_TESTS = [
  ...FIFO_REFUSAL_TESTS,
  "when the lock names a slug with a newline",
  "when a grant entry of the spec contains U+0085",
];
const NOTICE_PRINT_TEST = "prints each notice on one line when the work folder";
// The tests whose session exits with its own failure code, which the check leaves as it is.
const SESSION_FAILS_ITSELF_TESTS = [
  "own exit 3",
  "cannot be started after the change",
  "exit 3 when the session writes a protected file",
];
// The tests that need a run to end 4 and do not carry the phrase every protected change carries.
const EXIT_4_TESTS = [
  "records checkError and exits 4",
  "exits 4 and prints LK RECORD NOT WRITTEN",
  "prints one check-failed line",
];

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
    replacement: "    const changes: KindedChange[] = [];",
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
    redTest: namedAny([...BELOW_FOLDER_TESTS, ...FIFO_REFUSAL_TESTS]),
  },
  {
    element: "the after-run check covering the folder a folder grant names",
    pattern: /^ {2}if \(path === withoutTrailingSlash\(entry\)\) return true;$/m,
    replacement: "",
    redTest: namedAny(["mode of the folder the grant names", ...GRANT_COVERS_FOLDER_ABOVE_TESTS]),
  },
  {
    element: "the after-run check covering the folders created to reach a granted path",
    pattern:
      /^ {2}return isCreationOrRemoval && entry\.startsWith\(`\$\{withoutTrailingSlash\(path\)\}\/`\);$/m,
    replacement: "  return false;",
    redTest: namedAny([
      "with its parent folder missing",
      "with docs/.claude missing as well",
      "creates the folders and the file a file grant names",
    ]),
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
      /^ {2}try \{\n {4}step\(\);\n {4}return true;\n {2}\} catch \(error\) \{\n {4}print\(`\$\{notice\}: \$\{escapedControlCharacters\(messageOf\(error\)\)\}`\);\n {4}return false;\n {2}\}$/m,
    replacement: "  step();\n  return true;",
    redTest: namedAny([
      "cannot be replaced after a protected change",
      "LK LOCK NOT REMOVED",
      "when only snapshot-after.json cannot be replaced",
      "when only run.json cannot be replaced",
      "becomes a link",
      NOTICE_PRINT_TEST,
    ]),
  },
  {
    element: "the after-run check watching the product root spellings of the docs files",
    pattern: /^ {2}"CLAUDE\.md",\n {2}"AGENTS\.md",\n {2}"\.claude",\n/m,
    replacement: "",
    redTest: namedAny(["at the product root", SET_LITERAL_TEST]),
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
      ...FIFO_REFUSAL_TESTS,
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
  {
    element: "the after-run check covering a folder above a granted path whatever sits there",
    pattern: /^ {2}if \(kind !== "folder"\) return false;$/m,
    replacement: "",
    redTest: namedAny([
      "names the missing ancestor when the session creates it",
      "creates a granted folder that does not exist yet as a link",
    ]),
  },
  {
    element: "the after-run check covering a link at a granted path",
    pattern: /^ {2}if \(kind === "link"\) return false;$/m,
    replacement: "",
    redTest: namedAny([
      "creates a granted file that does not exist yet as a link",
      "creates a granted folder that does not exist yet as a link",
    ]),
  },
  {
    element: "the after-run check covering a granted path that changed kind",
    pattern: /^ {2}if \(change === "kind changed"\) return false;$/m,
    replacement: "",
    redTest: namedAny(["replaces the granted file with a folder"]),
  },
  {
    element: "the after-run check matching a file grant by prefix",
    pattern: /^ {2}if \(!entry\.endsWith\("\/"\)\) return path === entry;$/m,
    replacement: '  if (!entry.endsWith("/")) return path.startsWith(entry);',
    redTest: namedAny(["merely starts with the name of a granted file"]),
  },
  {
    element: "the after-run check matching a folder grant without its slash",
    pattern: /^ {2}return path\.startsWith\(entry\);$/m,
    replacement: "  return path.startsWith(withoutTrailingSlash(entry));",
    redTest: namedAny(["merely starts with the name of a granted folder"]),
  },
  {
    element: "the after-run check comparing paths without folding case",
    pattern:
      /^ {2}const folded = \{ \.\.\.change, path: change\.path\.toLowerCase\(\) \};\n {2}return entries\.some\(\(entry\) => entryCoversChange\(entry\.toLowerCase\(\), folded\)\);$/m,
    replacement: "  return entries.some((entry) => entryCoversChange(entry, change));",
    redTest: namedAny(["spells the path in another case", "is spelled DOCS/PROJECT/"]),
  },
  {
    element: "the after-run check reading the grant again after the session",
    pattern: /^ {2}const verdict = checkProtectedPaths\(root, check\);$/m,
    // The space after the name keeps a text search for the call at the dispatcher's one site. A
    // second resolution that refuses an entry the session has put a link or a folder at keeps the
    // grant read before the session, so a test is red only when the grant read again covers a change.
    replacement:
      "  let grant = check.grant;\n  try {\n    grant = readGovernanceGrant (root, record.slug);\n  } catch {\n    grant = check.grant;\n  }\n  const verdict = checkProtectedPaths(root, { ...check, grant });",
    redTest: namedAny(["rewrites the grant line of the spec"]),
  },
  {
    element: "the after-run check comparing the permission bits of an entry",
    path: SNAPSHOT_PATH,
    pattern: /^ {2}before\.mode === after\.mode && /m,
    replacement: "  ",
    redTest: namedAny([
      "reports a permission change as changed",
      "whose mode the session changes",
      "prints one line per path with its kind of change",
      "its mode changes",
    ]),
  },
  {
    element: "the after-run check comparing the target of a link",
    path: SNAPSHOT_PATH,
    pattern: / && before\.target === after\.target;$/m,
    replacement: ";",
    redTest: namedAny(["reports a link whose target text changed as changed", "is retargeted"]),
  },
  {
    element: "the after-run check refusing a run when docs/ is absent",
    pattern: /^ {2}if \(!options\.dryRun\) requireDocsFolder\(root\);$/m,
    replacement: "",
    redTest: namedAny(["when docs/ is absent"]),
  },
  {
    element: "the after-run check refusing a run whose first snapshot cannot be taken",
    pattern:
      /^ {4}return refuse\(`cannot snapshot the protected paths: \$\{messageOf\(error\)\}`\);$/m,
    replacement: "    throw error;",
    redTest: namedAny(["when the first snapshot cannot be taken", ...FIFO_REFUSAL_TESTS]),
  },
  {
    element:
      "the after-run check ending a run done when only the second snapshot file was not written",
    pattern:
      /^ {2}return checkFailed \|\| !evidenceWritten \? failureExit\(end\) : end\.exitCode;$/m,
    replacement: "  return checkFailed ? failureExit(end) : end.exitCode;",
    redTest: namedAny(["exits 4 and prints LK RECORD NOT WRITTEN when only snapshot-after.json"]),
  },
  {
    element: "the after-run check ending a run done when only the run record was not written",
    pattern: /^ {2}return recordWritten \? exitCode : failureExit\(end\);$/m,
    replacement: "  return exitCode;",
    redTest: namedAny(["exits 4 and prints LK RECORD NOT WRITTEN when only run.json"]),
  },
  {
    element: "the after-run check watching the git parts of both repositories",
    pattern:
      /^ {2}"\.git\/config",\n {2}"\.git\/hooks\/",\n {2}"docs\/\.git\/config",\n {2}"docs\/\.git\/hooks\/",\n/m,
    replacement: "",
    redTest: namedAny([
      SET_LITERAL_TEST,
      "covers every path of PROTECTED_PATHS",
      "is checked by a pin that names the path a set leaves out",
      "ends failed when the run changes the file .git/config",
      "ends failed when the run changes the file docs/.git/config",
      "names the folder .git with kind changed",
      "names the folder docs/.git with kind changed",
      "writes the folders above the set into snapshot-before.json",
      "adds a file below the folder .git/hooks/",
      "adds a file below the folder docs/.git/hooks/",
      "records checkError and exits 4",
      "when the first snapshot cannot be taken",
    ]),
  },
  {
    element: "the after-run check checking the work folder after the session before each write",
    pattern: /^ {6}requireRealWorkFolder\(root, slug\);$/m,
    replacement: "",
    redTest: namedAny(["becomes a link", NOTICE_PRINT_TEST]),
  },
  {
    element: "the after-run check checking the work folder before removing the lock",
    pattern: /^ {8}requireRealWorkFolder\(root\);$/m,
    replacement: "",
    redTest: namedAny(["when .work itself becomes a link"]),
  },
  {
    element: "the after-run check refusing a work folder that is a link at dispatch start",
    pattern: /^ {2}if \(!options\.dryRun\) requireRealWorkFolder\(root, slug\);$/m,
    replacement: "",
    redTest: namedAny(["when .work/alpha is a link", "when .work is a link"]),
  },
  {
    element: "the after-run check refusing a work folder that is a link before the lock is taken",
    pattern:
      /^ {2}if \(!options\.dryRun\) requireRealWorkFolder\(root, slug\);\n {2}refuseIfLockHeld\(root, deps, !options\.dryRun\);\n {2}if \(options\.dryRun\) \{\n {4}printDryRun\(options, session, promptText, deps\.print\);\n {4}return 0;\n {2}\}\n {2}const exitCode = await runHoldingLock\(root, lockHolderOf\(deps, slug\), deps\.print, async \(\) => \{$/m,
    replacement:
      "  refuseIfLockHeld(root, deps, !options.dryRun);\n  if (options.dryRun) {\n    printDryRun(options, session, promptText, deps.print);\n    return 0;\n  }\n  const exitCode = await runHoldingLock(root, lockHolderOf(deps, slug), deps.print, async () => {\n    requireRealWorkFolder(root, slug);",
    redTest: namedAny(["when .work is a link"]),
  },
  {
    element: "the after-run check making the work folder writable before a write after the session",
    pattern: /^ {6}chmodSync\(workPath\(root, slug\), WORK_FOLDER_MODE\);$/m,
    replacement: "",
    redTest: namedAny(["forges run.json as done and makes the work folder read-only"]),
  },
  {
    element: "the after-run check naming the lock temporary file by the pid",
    pattern:
      /^ {2}const temporaryPath = workPath\(root, `\$\{LOCK_FILE\}\.\$\{randomUUID\(\)\}\$\{TEMPORARY_SUFFIX\}`\);$/m,
    replacement:
      "  const temporaryPath = workPath(root, `${LOCK_FILE}.${holder.pid}${TEMPORARY_SUFFIX}`);",
    redTest: namedAny([
      "when a link sits at the temporary name its pid would use",
      "publishes a finished file with link",
      "publishes the session pid with rename",
    ]),
  },
  {
    element: "the after-run check printing a changed path as the filesystem spells it",
    pattern:
      /^ {4}print\(`LK PROTECTED PATH CHANGED: \$\{escapedText\(path\)\} \(\$\{change\}\)`\);$/m,
    replacement: "    print(`LK PROTECTED PATH CHANGED: ${path} (${change})`);",
    redTest: namedAny(["holds a newline", "holds U+0085"]),
  },
  {
    element: "the after-run check taking the lock before the smoke call",
    pattern:
      /^ {2}const exitCode = await runHoldingLock\(root, lockHolderOf\(deps, slug\), deps\.print, async \(\) => \{\n {4}const before = snapshotBeforeRun\(root, slug\);\n {4}if \(!options\.noSmoke\) \{\n {6}refuseUnlessModelAnswers\(session\.model, \{ cwd: root, env: childEnv \}, deps\.runSmoke\);\n {4}\}$/m,
    replacement:
      "  const before = snapshotBeforeRun(root, slug);\n  if (!options.noSmoke) {\n    refuseUnlessModelAnswers(session.model, { cwd: root, env: childEnv }, deps.runSmoke);\n  }\n  const exitCode = await runHoldingLock(root, lockHolderOf(deps, slug), deps.print, async () => {",
    redTest: namedAny([
      "holds the lock while the smoke call runs",
      "takes the lock first, before the smoke call",
    ]),
  },
  {
    element: "the after-run check releasing the lock before the second snapshot",
    pattern: /^ {4}exitCode = concludeRun\(root, record, end, check, deps\.print\);$/m,
    replacement:
      "    try {\n      requireRealWorkFolder(root);\n      rmSync(workPath(root, LOCK_FILE), { force: true });\n    } catch {\n      // the lock cannot be removed here\n    }\n    exitCode = concludeRun(root, record, end, check, deps.print);",
    redTest: namedAny([
      "is still held while the second snapshot reads the protected paths",
      "has written the final record by the time the lock is removed",
    ]),
  },
  {
    element: "the after-run check printing the text of a failed check as the filesystem spells it",
    pattern:
      /^ {4}print\(`LK PROTECTED PATH CHECK FAILED: \$\{escapedText\(verdict\.checkError\)\}`\);$/m,
    replacement: "    print(`LK PROTECTED PATH CHECK FAILED: ${verdict.checkError}`);",
    redTest: namedAny(["prints one check-failed line"]),
  },
  {
    element: "the after-run check escaping the C1 control characters of a printed name",
    pattern:
      /^const escapedText = \(text: string\): string => escapedC1Controls\(JSON\.stringify\(text\)\.slice\(1, -1\)\);$/m,
    replacement: "const escapedText = (text: string): string => JSON.stringify(text).slice(1, -1);",
    redTest: namedAny([
      "holds U+0085",
      "with U+009B escaped",
      "a fifo below docs/.claude whose name holds it",
      "contains U+0085",
    ]),
  },
  {
    element: "the after-run check printing a refusal as the filesystem spells it",
    pattern:
      /^ {4}console\.error\(`LK REFUSED: \$\{escapedControlCharacters\(error\.message\)\}`\);$/m,
    replacement: "    console.error(`LK REFUSED: ${error.message}`);",
    redTest: namedAny(REFUSAL_PRINT_TESTS),
  },
  {
    element: "the after-run check printing the run record of status as the filesystem spells it",
    pattern: /^ {4}console\.log\(escapedC1Controls\(statusText\)\);$/m,
    replacement: "    console.log(statusText);",
    redTest: namedAny(["prints U+009B of the run record"]),
  },
  {
    element: "the after-run check printing the message of a notice as the filesystem spells it",
    pattern:
      /^ {4}print\(`\$\{notice\}: \$\{escapedControlCharacters\(messageOf\(error\)\)\}`\);$/m,
    replacement: "    print(`${notice}: ${messageOf(error)}`);",
    redTest: namedAny([NOTICE_PRINT_TEST]),
  },
  {
    element: "the after-run check recording the folders above the set",
    path: SNAPSHOT_PATH,
    pattern:
      /^ {2}const entries: SnapshotEntry\[\] = ancestorFoldersOf\(set\)\.map\(\(path\) => entryAt\(root, path\)\);$/m,
    replacement: "  const entries: SnapshotEntry[] = [];",
    redTest: namedAny(FOLDER_ABOVE_SET_TESTS),
  },
  {
    element: "the after-run check reporting a folder above the set that appears",
    pattern: /^ {2}kind === "folder" && \(change === "added" \|\| change === "removed"\);$/m,
    replacement: '  kind === "folder" && change === "removed";',
    redTest: namedAny(["creates it as a folder with a file outside the set"]),
  },
  {
    element: "the after-run check reporting a folder above the set that disappears",
    pattern: /^ {2}kind === "folder" && \(change === "added" \|\| change === "removed"\);$/m,
    replacement: '  kind === "folder" && change === "added";',
    redTest: namedAny([
      "holds only a file outside the set at the start and the session removes it",
    ]),
  },
  {
    element:
      "the after-run check reporting a change at a folder above the set whatever the grant names",
    pattern: /^ {2}return !isCoveredBy\(grant, change\);$/m,
    replacement: "  return isAncestorOfSet(change) || !isCoveredBy(grant, change);",
    redTest: namedAny(GRANT_COVERS_FOLDER_ABOVE_TESTS),
  },
  {
    element: "the after-run check covering a change at a folder above the set by any grant at all",
    pattern: /^ {2}return !isCoveredBy\(grant, change\);$/m,
    replacement:
      "  return isAncestorOfSet(change) ? grant.length === 0 : !isCoveredBy(grant, change);",
    redTest: namedAny(GRANT_LEAVES_FOLDER_ABOVE_REPORTED_TESTS),
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
