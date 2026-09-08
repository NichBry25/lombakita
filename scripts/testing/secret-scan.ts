/**
 * Fails the build when a credential is committed as source text.
 *
 * Run over the tracked working tree by default, which is the population that ships publicly:
 *
 *   npm run verify:secrets
 *
 * Run over every object in the repository, including unreachable and dangling ones and any
 * pre-rewrite history still present locally, with:
 *
 *   npm run verify:secrets -- --history
 *
 * The two modes answer different questions. The tree mode answers "is a secret shipping right
 * now", which is what a pull request needs to know. The history mode answers "has a secret ever
 * been reachable", which a tree scan cannot see and which is the question that matters after a
 * leak, because a value stays compromised after the commit that removed it.
 *
 * WHY THIS EXISTS. A production database password sat in a tracked source file on `main` in a
 * public repository for 101 days. Fifteen `verify:*` gates ran over it the whole time. Every one
 * of them asks whether code MISBEHAVES WHEN IT RUNS, and the file holding the password is
 * imported by nothing, is in no npm script, and is bundled by no build, so it executed in none of
 * them while remaining fully public as text. Nothing here inspects behaviour. It reads what is
 * committed.
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  applyAllowlist,
  classifyContent,
  isForbiddenEnvPath,
  scanText,
  validateAllowlist,
  type AllowlistEntry,
  type Finding,
} from "../lib/secret-rules";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const ALLOWLIST_PATH = join(REPO_ROOT, ".secret-allowlist.json");

const scanHistory = process.argv.includes("--history");

/**
 * Explicit paths to scan instead of the tracked tree. Lets a caller check one file, which is how
 * this gate's own tests drive it: a test that builds a Finding by hand proves the rule, not the
 * wiring, so the tests invoke this runner the way CI does and read its exit code.
 */
const explicitPaths = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));

type Subject = {
  readonly label: string;
  readonly scanned: number;
  readonly declaredBinary: number;
  readonly unclassifiable: string[];
};

const loadAllowlist = (): readonly AllowlistEntry[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error(`FAIL: ${ALLOWLIST_PATH} is not valid JSON.\n${String(error)}`);
    process.exit(1);
  }

  const { entries, errors } = validateAllowlist(raw);
  if (errors.length > 0) {
    console.error("FAIL: .secret-allowlist.json is invalid.\n");
    for (const message of errors) console.error(`  ${message}`);
    console.error(
      "\nAn entry without a written reason is an unexplained hole in this gate, so it is rejected.",
    );
    process.exit(1);
  }

  return entries;
};

const scanTrackedTree = (): { findings: Finding[]; subject: Subject } => {
  const usingExplicitPaths = explicitPaths.length > 0;
  const listed = usingExplicitPaths
    ? ""
    : execFileSync("git", ["ls-files", "-z"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
  const paths = usingExplicitPaths
    ? explicitPaths
    : listed.split("\0").filter((path) => path.length > 0);
  const resolveFrom = usingExplicitPaths ? process.cwd() : REPO_ROOT;

  const findings: Finding[] = [];
  const unclassifiable: string[] = [];
  let scanned = 0;
  let declaredBinary = 0;

  for (const path of paths) {
    if (isForbiddenEnvPath(path)) {
      findings.push({
        ruleId: "tracked-env-file",
        description: "An environment file is tracked by git. These hold real values by definition.",
        path,
        line: 1,
        preview: path,
        fingerprint: "tracked-env-file",
      });
    }

    let bytes: Buffer;
    try {
      // `resolve` rather than `join` so an absolute path passes through unchanged.
      bytes = readFileSync(resolve(resolveFrom, path));
    } catch {
      // A tracked path that cannot be read is not something to pass over quietly.
      unclassifiable.push(`${path} (unreadable)`);
      continue;
    }

    const classification = classifyContent(bytes, path);
    if (classification === "unclassifiable") {
      unclassifiable.push(path);
      continue;
    }
    if (classification === "declared-binary") {
      declaredBinary += 1;
      continue;
    }

    scanned += 1;
    findings.push(...scanText(bytes.toString("utf8"), path));
  }

  return {
    findings,
    subject: {
      label: usingExplicitPaths
        ? `${paths.length} explicitly named file(s)`
        : `${paths.length} tracked files`,
      scanned,
      declaredBinary,
      unclassifiable,
    },
  };
};

/**
 * Streams every object in the repository. `--batch-all-objects` is deliberate: `rev-list --all`
 * walks only what a ref points at, and the objects that matter most after a history rewrite are
 * exactly the ones no ref points at any more.
 */
const scanAllObjects = async (): Promise<{ findings: Finding[]; subject: Subject }> => {
  const pathOfOid = new Map<string, string>();
  const named = execFileSync("git", ["rev-list", "--objects", "--all", "--reflog"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  for (const line of named.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) {
      const oid = line.slice(0, space);
      if (!pathOfOid.has(oid)) pathOfOid.set(oid, line.slice(space + 1));
    }
  }

  const child = spawn("git", ["cat-file", "--batch-all-objects", "--batch"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });

  const findings: Finding[] = [];
  const unclassifiable: string[] = [];
  let scanned = 0;
  let declaredBinary = 0;
  let blobs = 0;

  let buffer = Buffer.alloc(0);
  // The stream is a sequence of "<oid> <type> <size>\n<payload>\n", so the parser has to hold
  // partial chunks until a whole payload has arrived.
  let pendingHeader: { oid: string; type: string; size: number } | null = null;

  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        if (pendingHeader === null) {
          const newline = buffer.indexOf(0x0a);
          if (newline === -1) return;

          const header = buffer.subarray(0, newline).toString("utf8").split(" ");
          buffer = buffer.subarray(newline + 1);
          if (header.length < 3) continue;

          pendingHeader = {
            oid: header[0] ?? "",
            type: header[1] ?? "",
            size: Number.parseInt(header[2] ?? "0", 10),
          };
        }

        if (buffer.length < pendingHeader.size + 1) return;

        const payload = buffer.subarray(0, pendingHeader.size);
        buffer = buffer.subarray(pendingHeader.size + 1);
        const { oid, type } = pendingHeader;
        pendingHeader = null;

        if (type !== "blob") continue;
        blobs += 1;

        const path = pathOfOid.get(oid) ?? `<unreachable object ${oid.slice(0, 10)}>`;
        const classification = classifyContent(payload, path);
        if (classification === "unclassifiable") {
          unclassifiable.push(path);
          continue;
        }
        if (classification === "declared-binary") {
          declaredBinary += 1;
          continue;
        }

        scanned += 1;
        findings.push(...scanText(payload.toString("utf8"), path));
      }
    });

    child.stdout.on("end", resolve);
    child.on("error", reject);
  });

  return {
    findings,
    subject: {
      label: `${blobs} blobs across all objects, including unreachable and dangling`,
      scanned,
      declaredBinary,
      unclassifiable,
    },
  };
};

const main = async (): Promise<void> => {
  const allowlist = loadAllowlist();
  const { findings, subject } = scanHistory ? await scanAllObjects() : scanTrackedTree();
  const { reported, suppressed } = applyAllowlist(findings, allowlist);

  // The subject is printed as data. A reader must be able to see what population this gate
  // actually covered, rather than inferring it from the gate's name.
  console.log("secret scan");
  console.log(`  mode              ${scanHistory ? "--history (all objects)" : "tracked tree"}`);
  console.log(`  subject           ${subject.label}`);
  console.log(`  scanned as text   ${subject.scanned}`);
  console.log(`  declared binary   ${subject.declaredBinary}`);
  console.log(`  allowlisted       ${suppressed.length} match(es), ${allowlist.length} entr(ies)`);
  console.log(`  unclassifiable    ${subject.unclassifiable.length}`);

  if (subject.unclassifiable.length > 0) {
    console.error("\nFAIL: inputs this scanner could not classify.\n");
    for (const path of subject.unclassifiable.slice(0, 50)) console.error(`  ${path}`);
    console.error(
      "\nSkipping these would mean the gate silently covers less than its name implies.\n" +
        "Either the file is binary, in which case add its extension to DECLARED_BINARY_EXTENSIONS\n" +
        "in scripts/lib/secret-rules.ts, or it should not be tracked.",
    );
    process.exit(1);
  }

  if (reported.length === 0) {
    console.log("\nPASS: no unallowlisted credential found.");
    return;
  }

  console.error(`\nFAIL: ${reported.length} finding(s).\n`);
  for (const finding of reported) {
    console.error(`  ${finding.path}:${finding.line}`);
    console.error(`    rule        ${finding.ruleId}`);
    console.error(`    match       ${finding.preview}`);
    console.error(`    fingerprint ${finding.fingerprint}`);
    console.error(`    ${finding.description}`);
    console.error("");
  }
  console.error(
    "If a finding is a real credential, treat it as compromised and rotate it. Removing the line\n" +
      "does not undo the exposure. If it is not a credential, add its fingerprint to\n" +
      ".secret-allowlist.json with a reason saying why.",
  );
  process.exit(1);
};

void main();
