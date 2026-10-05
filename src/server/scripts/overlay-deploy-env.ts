/**
 * Deploy gate, step zero: fill the nine Sensitive secrets into the file `vercel pull` wrote.
 *
 * A Sensitive Vercel variable is pulled EMPTY (INFRA-D1), so the workflow also keeps the nine as
 * write-only GitHub environment secrets and passes them in here as `MIRROR_<NAME>`. This rewrites
 * only those nine keys in the pulled file, so layer 1, layer 2, the schema gate and `vercel build`
 * all read real values from the one file they already read.
 *
 *   npm run deploy:overlay-env -- --environment=preview
 *
 * Fails closed: drift between Vercel's plain value and the GitHub copy, a mirror value this writer
 * cannot emit safely, a duplicated key, or a rewrite that would change any other key all stop the
 * job before anything is written. Output is names and statuses only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import {
  OVERLAY_NAMES,
  hasBlockingOverlayStatus,
  overlayDeployEnv,
  type OverlayName,
  type OverlayReportEntry,
} from "@/config/deploy-env-overlay";
import {
  ENV_PATH_FLAG,
  parseDeployEnvironment,
  pulledEnvFilePath,
  readFlagValue,
} from "@/server/scripts/env-file";

export class PulledEnvFileMissingError extends Error {}
export class DuplicateOverlayKeyError extends Error {}
export class OverlayVerificationError extends Error {}

type EnvMap = Readonly<Record<string, string | undefined>>;

const LINE_BREAK = /(\r?\n)/;

const overlayKeyPattern = (name: OverlayName): RegExp =>
  new RegExp(`^\\s*(?:export\\s+)?${name}(?:\\s*=|:\\s)`);

/** Index in `pieces` of each overlay key's line. Even indexes are lines, odd are their breaks. */
const indexOverlayLines = (pieces: readonly string[]): Map<OverlayName, number> => {
  const indexes = new Map<OverlayName, number>();

  for (const name of OVERLAY_NAMES) {
    const pattern = overlayKeyPattern(name);

    for (let index = 0; index < pieces.length; index += 2) {
      if (!pattern.test(pieces[index] ?? "")) {
        continue;
      }

      if (indexes.has(name)) {
        throw new DuplicateOverlayKeyError(`${name} appears more than once`);
      }

      indexes.set(name, index);
    }
  }

  return indexes;
};

const withAppendedLines = (pieces: readonly string[], lines: readonly string[]): string => {
  const base = pieces.join("");

  if (lines.length === 0) {
    return base;
  }

  const separator = base === "" || base.endsWith("\n") ? "" : "\n";

  return `${base}${separator}${lines.map((line) => `${line}\n`).join("")}`;
};

// Re-parsing the whole file is what proves "only the nine keys changed": a line that merely LOOKED
// like an overlay key, inside another variable's multi-line value, would pass the line scan and
// corrupt that variable here.
const assertRewriteParsesToMerged = (rewritten: string, expected: EnvMap): void => {
  const actual = parseEnv(rewritten);
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);

  for (const key of keys) {
    if (actual[key] !== expected[key]) {
      throw new OverlayVerificationError("the rewritten file does not parse to the merged values");
    }
  }
};

export const overlayEnvFileText = (
  text: string,
  mirror: EnvMap,
): { text: string; report: OverlayReportEntry[] } => {
  const pieces = text.split(LINE_BREAK);
  const lineIndexes = indexOverlayLines(pieces);
  const { merged, report } = overlayDeployEnv(parseEnv(text), mirror);

  if (hasBlockingOverlayStatus(report)) {
    return { text, report };
  }

  const appendedLines: string[] = [];

  for (const entry of report.filter((item) => item.status === "filled-from-github")) {
    const line = `${entry.name}='${merged[entry.name]}'`;
    const index = lineIndexes.get(entry.name);

    if (index === undefined) {
      appendedLines.push(line);
    } else {
      pieces[index] = line;
    }
  }

  const rewritten = withAppendedLines(pieces, appendedLines);

  assertRewriteParsesToMerged(rewritten, merged);

  return { text: rewritten, report };
};

const readMirrorFromProcessEnv = (): EnvMap =>
  Object.fromEntries(OVERLAY_NAMES.map((name) => [name, process.env[`MIRROR_${name}`]]));

const printReport = (report: readonly OverlayReportEntry[]): void => {
  for (const { name, status } of report) {
    console.log(`overlay: ${name} ${status}`);

    if (status === "not-mirrored") {
      console.log(
        `::warning::overlay: ${name} is not mirrored in GitHub; the Vercel value is used unchecked`,
      );
    }
  }
};

const overlayPulledEnvFile = (environment: string, filePath: string): void => {
  if (!existsSync(filePath)) {
    throw new PulledEnvFileMissingError("the pulled env file does not exist");
  }

  console.log(`overlay: environment=${environment} file=${filePath}`);

  const original = readFileSync(filePath, "utf8");
  const { text, report } = overlayEnvFileText(original, readMirrorFromProcessEnv());

  printReport(report);

  if (hasBlockingOverlayStatus(report)) {
    process.exitCode = 1;
    return;
  }

  if (text !== original) {
    writeFileSync(filePath, text);
  }
};

// Class and path only, never the message: a message is free text this script does not control, and
// everything in the file it names is a secret.
const describeFailure = (error: unknown, filePath: string | undefined): string => {
  const errorClass = error instanceof Error ? error.constructor.name : "NonErrorThrown";

  return `Deploy env overlay failed: ${errorClass}${filePath ? ` (${filePath})` : ""}`;
};

const run = (): void => {
  const argv = process.argv.slice(2);
  let filePath: string | undefined;

  try {
    const environment = parseDeployEnvironment(readFlagValue(argv, "--environment"));

    filePath = readFlagValue(argv, ENV_PATH_FLAG) ?? pulledEnvFilePath(environment);
    overlayPulledEnvFile(environment, filePath);
  } catch (error: unknown) {
    console.error(describeFailure(error, filePath));
    process.exitCode = 1;
  }
};

// Runs on load only as the entry module, so a test can import overlayEnvFileText without
// rewriting a file.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run();
}
