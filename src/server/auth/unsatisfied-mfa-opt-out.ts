import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import ts from "typescript";

export const MFA_OPT_OUT_NAME = "allowUnsatisfiedMfa";
export const AUTH_SOURCE_POPULATION = {
  command: "git",
  arguments: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  extensions: /\.[cm]?[jt]sx?$/,
};

export const enumerateRepositorySourceFiles = (): string[] => {
  const files = execFileSync(AUTH_SOURCE_POPULATION.command, AUTH_SOURCE_POPULATION.arguments, {
    encoding: "utf8",
  }).split("\0");
  return [...new Set(files)].filter(
    (file) =>
      AUTH_SOURCE_POPULATION.extensions.test(file) &&
      !file.split("/").some((part) => part.startsWith(".env") || part === ".vercel"),
  );
};

export const MFA_OPT_OUT_ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "src/server/auth/session.ts": {
    count: 3,
    reason: "Declares the MFA exception and defers MFA disclosure until after role refusal.",
  },
  "src/server/auth/mfa/mfa-route-guard.ts": {
    count: 1,
    reason: "MFA lifecycle handlers must run before MFA is satisfied.",
  },
  "src/server/auth/session.test.ts": {
    count: 2,
    reason: "Declares the test option type and exercises the explicit lifecycle exception.",
  },
  "src/server/auth/unsatisfied-mfa-opt-out.ts": {
    count: 1,
    reason: "Names the token inspected by the shared scanner.",
  },
  "src/server/auth/unsatisfied-mfa-opt-out.test.ts": {
    count: 19,
    reason: "Contains scanner fixtures for the prohibited token spellings.",
  },
  "scripts/testing/probes/session-mfa-default.mjs": {
    count: 1,
    reason: "Names the exact production guard removed by the existing MFA-default probe.",
  },
};

export const enumerateAuthSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.name.startsWith(".env") || entry.name === ".vercel") return [];
    return entry.isDirectory()
      ? enumerateAuthSourceFiles(file)
      : /\.[cm]?[jt]sx?$/.test(file)
        ? [file]
        : [];
  });

export const scanMfaOptOutNames = (text: string, file: string): number[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics.length > 0) throw new Error(`Cannot parse auth source: ${file}`);
  const lines: number[] = [];
  const token = new RegExp(`\\b${MFA_OPT_OUT_NAME}\\b`, "g");
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === MFA_OPT_OUT_NAME) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const match of node.text.matchAll(token)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const precedingLines = node.text.slice(0, match.index).split("\n").length - 1;
        lines.push(line + precedingLines);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
};

export const censusMfaOptOutNames = () =>
  enumerateRepositorySourceFiles().flatMap((file) => {
    const lines = scanMfaOptOutNames(readFileSync(file, "utf8"), file);
    return lines.length === 0 ? [] : [{ file, count: lines.length, lines }];
  });
