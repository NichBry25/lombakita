/**
 * Deploy gate, step zero: fill the nine Sensitive secrets into the file `vercel pull` wrote.
 *
 * A Sensitive Vercel variable is not pulled: CLI 56 writes an empty string (INFRA-D1), CLI 62 writes
 * the placeholder `[SENSITIVE]`. The workflow therefore also keeps the nine as
 * write-only GitHub environment secrets and passes them in here as `MIRROR_<NAME>`. This rewrites
 * only those nine keys in the pulled file, so layer 1, layer 2, the schema gate and `vercel build`
 * all read real values from the one file they already read.
 *
 *   npm run deploy:overlay-env -- --environment=preview
 *
 * Fails closed: drift between Vercel's plain value and the GitHub copy, a mirror value this writer
 * cannot emit safely (including the placeholder itself), a duplicated key, or a rewrite that would
 * change any other key all stop the job before anything is written. A Sensitive name with no GitHub
 * copy stops the job here, by name, rather than at layer 1, and so does a Sensitive NEXT_PUBLIC_
 * name, which would ship the placeholder to every browser. Output is names and statuses only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import {
  OVERLAY_NAMES,
  findSensitivePlaceholdersOutsideOverlay,
  hasBlockingOverlayStatus,
  overlayDeployEnv,
  type OverlayName,
  type OverlayReportEntry,
  type OverlayStatus,
} from "@/config/deploy-env-overlay";
import {
  ENV_PATH_FLAG,
  InvalidDeployEnvironmentError,
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
const indexOverlayLines = (pieces: readonly string[]): Map<string, number> => {
  const indexes = new Map<string, number>();

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
): { text: string; report: OverlayReportEntry[]; placeholdersOutsideOverlay: string[] } => {
  const pieces = text.split(LINE_BREAK);
  const lineIndexes = indexOverlayLines(pieces);
  const pulled = parseEnv(text);
  const { merged, report } = overlayDeployEnv(pulled, mirror);
  const placeholdersOutsideOverlay = findSensitivePlaceholdersOutsideOverlay(pulled);

  if (hasBlockingOverlayStatus(report)) {
    return { text, report, placeholdersOutsideOverlay };
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

  return { text: rewritten, report, placeholdersOutsideOverlay };
};

const readMirrorFromProcessEnv = (): EnvMap =>
  Object.fromEntries(OVERLAY_NAMES.map((name) => [name, process.env[`MIRROR_${name}`]]));

const annotationFor = (name: string, status: OverlayStatus): string | undefined => {
  switch (status) {
    case "not-mirrored":
      return `::warning::overlay: ${name} is not mirrored in GitHub; the Vercel value is used unchecked`;
    case "sensitive-unmirrored":
      return `::error::overlay: ${name} is Sensitive on Vercel and has no GitHub environment secret`;
    case "drift":
      return `::error::overlay: ${name} differs between the Vercel value and the GitHub environment secret`;
    case "unwritable":
      return `::error::overlay: ${name} has a GitHub environment secret the overlay cannot write to the pulled file`;
    case "sensitive-public-placeholder":
      return `::error::overlay: ${name} is Sensitive on Vercel but NEXT_PUBLIC_ values are compiled into the browser bundle; make it plain`;
    default:
      return undefined;
  }
};

const printReport = (
  report: readonly OverlayReportEntry[],
  placeholdersOutsideOverlay: readonly string[],
): void => {
  for (const { name, status } of report) {
    console.log(`overlay: ${name} ${status}`);

    const annotation = annotationFor(name, status);

    if (annotation) {
      console.log(annotation);
    }
  }

  for (const name of placeholdersOutsideOverlay) {
    console.log(`::warning::overlay: ${name} sensitive-placeholder-outside-overlay`);
  }
};

const overlayPulledEnvFile = (environment: string, filePath: string): void => {
  if (!existsSync(filePath)) {
    throw new PulledEnvFileMissingError("the pulled env file does not exist");
  }

  console.log(`overlay: environment=${environment} file=${filePath}`);

  const original = readFileSync(filePath, "utf8");
  const { text, report, placeholdersOutsideOverlay } = overlayEnvFileText(
    original,
    readMirrorFromProcessEnv(),
  );

  printReport(report, placeholdersOutsideOverlay);

  if (hasBlockingOverlayStatus(report)) {
    process.exitCode = 1;
    return;
  }

  if (text !== original) {
    writeFileSync(filePath, text);
  }
};

// Everything in the pulled file is a secret and a thrown message is free text this script does not
// control, so a failure prints the class, a filesystem `code` when there is one, and the path.
// The one message printed is InvalidDeployEnvironmentError's, which is fixed.
const errorCodeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;

  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
};

export const describeFailure = (error: unknown, filePath: string | undefined): string => {
  const location = filePath ? ` (${filePath})` : "";

  if (error instanceof InvalidDeployEnvironmentError) {
    return `Deploy env overlay failed: InvalidDeployEnvironmentError: ${error.message}${location}`;
  }

  const errorClass = error instanceof Error ? error.constructor.name : "NonErrorThrown";
  const code = errorCodeOf(error);

  return `Deploy env overlay failed: ${errorClass}${code ? ` [${code}]` : ""}${location}`;
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
