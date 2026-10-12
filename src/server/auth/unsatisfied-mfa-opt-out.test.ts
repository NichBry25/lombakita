// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MFA_OPT_OUT_ALLOWLIST,
  censusMfaOptOutNames,
  enumerateRepositorySourceFiles,
  scanMfaOptOutNames,
} from "./unsatisfied-mfa-opt-out";

export { scanMfaOptOutNames } from "./unsatisfied-mfa-opt-out";

export const OPT_OUT_FORMS = [
  "const options = { allowUnsatisfiedMfa: !!true };",
  "const options = { allowUnsatisfiedMfa: <boolean>true };",
  "const t = true; const options = { allowUnsatisfiedMfa: t };",
  "const allowUnsatisfiedMfa = true; const options = { allowUnsatisfiedMfa };",
  "const options = { [`allowUnsatisfiedMfa`]: true };",
  'const options = { [("allowUnsatisfiedMfa")]: true };',
  'const key = "allowUnsatisfiedMfa"; const options = { [key]: true };',
  "const options = { allowUnsatisfiedMfa: true ? true : false };",
  "const options = { allowUnsatisfiedMfa: Boolean(true) };",
  "const options = { get allowUnsatisfiedMfa() { return true; } };",
  "const options = { allowUnsatisfiedMfa: (true) };",
  "const options = { allowUnsatisfiedMfa: true as const };",
];

describe("unsatisfied MFA name enumeration", () => {
  it.each([
    {
      name: "string-built key",
      source:
        'const key = "allowUnsatisfied" + "Mfa"; requireAuthenticatedSession({ [key]: true });',
    },
    {
      name: "template-built key",
      source:
        'const key = `allowUnsatisfied${"Mfa"}`; requireAuthenticatedSession({ [key]: true });',
    },
    {
      name: "computed literal key",
      source: 'requireAuthenticatedSession({ ["anything"]: true });',
    },
    {
      name: "options alias",
      source:
        'const key = "anything"; const options = { [key]: true }; requireAuthenticatedSession(options);',
    },
    { name: "unclassifiable options", source: "requireAuthenticatedSession(buildOptions());" },
  ])("rejects $name", ({ source }) => {
    expect(scanMfaOptOutNames(source, "unlisted.ts").length).toBeGreaterThan(0);
  });
  const files = enumerateRepositorySourceFiles();
  it("enumerates a nonempty declared source population", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  it("permits names only within exact per-file counts", () => {
    expect(
      censusMfaOptOutNames().filter(
        ({ file, count }) => count !== MFA_OPT_OUT_ALLOWLIST[file]?.count,
      ),
    ).toEqual([]);
  });
  it.each(Object.entries(MFA_OPT_OUT_ALLOWLIST))(
    "%s contains exactly its pinned names and a nonempty reason",
    (file, { count, reason }) => {
      expect(typeof reason).toBe("string");
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(files).toContain(file);
      expect(scanMfaOptOutNames(readFileSync(file, "utf8"), file)).toHaveLength(count);
    },
  );
  it.each(OPT_OUT_FORMS)("detects every unlisted form: %s", (source) => {
    expect(scanMfaOptOutNames(source, "unlisted.ts").length).toBeGreaterThan(0);
  });
  it.each(Object.entries(MFA_OPT_OUT_ALLOWLIST))(
    "detects one extra occurrence in %s",
    (file, { count }) => {
      const source =
        readFileSync(file, "utf8") + "\nconst options = { allowUnsatisfiedMfa: true };";
      expect(scanMfaOptOutNames(source, file)).toHaveLength(count + 1);
    },
  );
  it("counts string literals and template chunks, ignoring comments", () => {
    const source =
      '// allowUnsatisfiedMfa\nconst a = "allowUnsatisfiedMfa"; const b = `allowUnsatisfiedMfa${1}allowUnsatisfiedMfa`;';
    expect(scanMfaOptOutNames(source, "inline.ts")).toEqual([2, 2, 2]);
  });
  it("counts names regardless of the value", () => {
    expect(scanMfaOptOutNames("const a = { allowUnsatisfiedMfa: false };", "inline.ts")).toEqual([
      1,
    ]);
  });
  it("refuses source that cannot be parsed", () => {
    expect(() => scanMfaOptOutNames("const = ;", "inline.ts")).toThrow("Cannot parse auth source");
  });
});
