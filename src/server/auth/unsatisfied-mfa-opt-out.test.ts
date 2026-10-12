// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MFA_OPT_OUT_ALLOWLIST,
  censusMfaGuardReferences,
  censusMfaOptOutNames,
  createMfaGuardReferenceScanner,
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
  describe("guard reference invariant", () => {
    const importGuard = 'import { requireAuthenticatedSession } from "@/server/auth/session";';
    const violating = [
      {
        name: "local alias with a string-built key",
        source: `${importGuard} const guard = requireAuthenticatedSession; const key = "allowUnsatisfied" + "Mfa"; guard({ [key]: true });`,
      },
      {
        name: "shadowed options (outer computed key, inner empty object)",
        source: `${importGuard} const key = "k"; const options = { [key]: true }; const inner = () => { const options = {}; return options; }; inner(); requireAuthenticatedSession(options);`,
      },
      {
        name: "string-built key",
        source: `${importGuard} const key = "allowUnsatisfied" + "Mfa"; requireAuthenticatedSession({ [key]: true });`,
      },
      {
        name: "template-built key",
        source: `${importGuard} const key = \`allowUnsatisfied\${"Mfa"}\`; requireAuthenticatedSession({ [key]: true });`,
      },
      {
        name: "options alias",
        source: `${importGuard} const key = "anything"; const options = { [key]: true }; requireAuthenticatedSession(options);`,
      },
      {
        name: "unresolved guard identifier",
        source: "requireAuthenticatedSession();",
      },
      { name: ".call(null)", source: `${importGuard} requireAuthenticatedSession.call(null);` },
      {
        name: ".apply(null, [])",
        source: `${importGuard} requireAuthenticatedSession.apply(null, []);`,
      },
      {
        name: "bound alias",
        source: `${importGuard} const bound = requireAuthenticatedSession.bind(null); bound();`,
      },
      {
        name: "returned guard",
        source: `${importGuard} const pick = () => requireAuthenticatedSession; pick()();`,
      },
      {
        name: "guard passed as an argument",
        source: `${importGuard} const run = (fn: () => unknown) => fn(); run(requireAuthenticatedSession);`,
      },
      {
        name: "bracket access on the namespace",
        source:
          'import * as auth from "@/server/auth/session"; auth["requireAuthenticatedSession"]();',
      },
      {
        name: "re-export",
        source: 'export { requireAuthenticatedSession } from "@/server/auth/session";',
      },
      {
        name: "renamed import",
        source:
          'import { requireAuthenticatedSession as guard } from "@/server/auth/session"; guard();',
      },
      {
        name: "dynamic import destructuring",
        source:
          'const { requireAuthenticatedSession: guard } = await import("@/server/auth/session"); guard();',
      },
      { name: "parenthesized callee", source: `${importGuard} (requireAuthenticatedSession)();` },
      { name: "optional call", source: `${importGuard} requireAuthenticatedSession?.();` },
      {
        name: "options variable",
        source: `${importGuard} const options = {}; requireAuthenticatedSession(options);`,
      },
      {
        name: "spread options",
        source: `${importGuard} const base = {}; requireAuthenticatedSession({ ...base });`,
      },
      {
        name: "computed key",
        source: `${importGuard} requireAuthenticatedSession({ ["literal"]: true });`,
      },
      {
        name: "call-result options",
        source: `${importGuard} requireAuthenticatedSession(buildOptions());`,
      },
    ];
    const accepted = [
      { name: "a plain call", source: `${importGuard} requireAuthenticatedSession();` },
      { name: "a plain {} call", source: `${importGuard} requireAuthenticatedSession({});` },
      {
        name: "a literal-named object",
        source: `${importGuard} requireAuthenticatedSession({ literalName: 1 });`,
      },
    ];
    // One program for every in-memory fixture: a program per fixture made this file take over a
    // minute.
    const fixtureSources = [...violating, ...accepted].map(({ source }) => source);
    const fixturePath = (source: string): string =>
      `src/fixtures/guard-${fixtureSources.indexOf(source)}.ts`;
    const scanFixtures = createMfaGuardReferenceScanner(
      Object.fromEntries(fixtureSources.map((source) => [fixturePath(source), source])),
    );
    const guardViolations = (source: string): number[] => scanFixtures(fixturePath(source));
    it.each(violating)("rejects $name", ({ source }) => {
      expect(guardViolations(source).length).toBeGreaterThan(0);
    });
    it.each(accepted)("still accepts $name", ({ source }) => {
      expect(guardViolations(source)).toEqual([]);
    });
    it("exempts the declaring file's test and no other file", () => {
      const source = `${importGuard} requireAuthenticatedSession.call(null);`;
      const scan = (file: string) => createMfaGuardReferenceScanner({ [file]: source })(file);
      expect(scan("src/server/auth/session.test.ts")).toEqual([]);
      expect(scan("src/server/auth/session-other.test.ts").length).toBeGreaterThan(0);
    });
  });
  describe("guard reference invariant on the production population", () => {
    const guardCensus = censusMfaGuardReferences();
    const realCaller = "src/server/auth/mfa/mfa-route-guard.ts";
    const scanReal = (source: string): number[] =>
      createMfaGuardReferenceScanner({ [realCaller]: source })(realCaller);
    it("accepts every guard reference under src", () => {
      expect(guardCensus).toEqual([]);
    });
    it("accepts the unmodified production file that calls the guard", () => {
      expect(scanReal(readFileSync(realCaller, "utf8"))).toEqual([]);
    });
    it("rejects an alias appended to that same production file", () => {
      const source = `${readFileSync(realCaller, "utf8")}\nexport const leaked = requireAuthenticatedSession;`;
      expect(scanReal(source).length).toBeGreaterThan(0);
    });
    it("rejects a computed options object appended to that same production file", () => {
      const source = `${readFileSync(realCaller, "utf8")}\nconst key = "k" + "ey";\nexport const leaked = requireAuthenticatedSession({ [key]: true });`;
      expect(scanReal(source).length).toBeGreaterThan(0);
    });
    it("refuses a file it cannot classify", () => {
      const scan = createMfaGuardReferenceScanner({ "src/new/route.ts": "export {};" });
      expect(() => scan("src/new/missing.ts")).toThrow("Cannot classify session source");
    });
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
