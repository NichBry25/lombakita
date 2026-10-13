import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createSessionGetterScanner,
  enumerateRepositorySourceFiles,
} from "@/server/auth/unsatisfied-mfa-opt-out";

const SESSION_PAGES: Record<string, string> = {
  "src/app/[username]/page.tsx": "Public profile reads the viewer session for the owner redirect.",
  "src/app/competitions/[institutionSlug]/[slug]/page.tsx":
    "Public competition detail reads the optional viewer session for candidate affordances.",
  "src/app/institution/[institutionSlug]/page.tsx":
    "Public institution hub reads membership before entering its existing recruiter guard.",
  "src/app/inbox/page.tsx": "Existing user inbox session gate is outside the four pages in P1d-2.",
  "src/app/profile/page.tsx":
    "Existing owner-profile session gate is outside the four pages in P1d-2.",
  "src/app/profile/edit/page.tsx":
    "Existing owner-profile edit session gate is outside the four pages in P1d-2.",
  "src/app/protected/page.tsx":
    "Development diagnostic asserts its session and refuses production rendering.",
};

const pages = enumerateRepositorySourceFiles().filter((file) =>
  /^src\/app\/(?:.*\/)?(page|layout)\.tsx$/.test(file),
);
const scanRepositorySessions = createSessionGetterScanner(
  Object.fromEntries(pages.map((file) => [file, readFileSync(file, "utf8")])),
);
const bypasses = [
  {
    name: "local alias",
    source:
      'import { getCurrentSession } from "@/server/auth/session"; const current = getCurrentSession; export default async function Page() { await current(); }',
  },
  {
    name: "destructuring alias",
    source:
      'import * as auth from "@/server/auth/session"; const { getCurrentSession: current } = auth; export default async function Page() { await current(); }',
  },
  {
    name: "renamed re-export",
    source:
      'import { current } from "@/server/auth/fixtures/session-guards/re-export"; export default async function Page() { await current(); }',
  },
  {
    name: "dynamic import destructuring",
    source:
      'export default async function Page() { const { getCurrentSession: current } = await import("@/server/auth/session"); await current(); }',
  },
  {
    name: "bracket access",
    source:
      'import * as auth from "@/server/auth/session"; export default async function Page() { await auth["getCurrentSession"](); }',
  },
  {
    name: "external wrapper",
    source:
      'import { readViewer } from "@/server/auth/fixtures/session-guards/wrapper"; export default async function Page() { await readViewer(); }',
  },
  ...[
    {
      name: "satisfies-wrapped getter",
      use: "await (getCurrentSession satisfies () => Promise<unknown>)();",
    },
    { name: "as-wrapped getter", use: "await (getCurrentSession as () => Promise<unknown>)();" },
    { name: "non-null getter", use: "await getCurrentSession!();" },
    { name: "parenthesized getter", use: "await (getCurrentSession)();" },
    { name: "getter .call(null)", use: "await getCurrentSession.call(null);" },
    { name: "getter .apply(null, [])", use: "await getCurrentSession.apply(null, []);" },
    {
      name: "bound getter alias",
      use: "const bound = getCurrentSession.bind(null); await bound();",
    },
    { name: "returned getter", use: "const pick = () => getCurrentSession; await pick()();" },
    {
      name: "getter passed as an argument",
      use: "const run = (fn: () => unknown) => fn(); await run(getCurrentSession);",
    },
  ].map(({ name, use }) => ({
    name,
    source: `import { getCurrentSession } from "@/server/auth/session"; export default async function Page() { ${use} }`,
  })),
  {
    name: "whole session namespace passed as an argument",
    source:
      'import * as auth from "@/server/auth/session"; const run = (value: unknown) => value; export default async function Page() { run(auth); }',
  },
  {
    name: "computed-key bracket access on the session namespace",
    source:
      'import * as auth from "@/server/auth/session"; const key = "getCurrent" + "Session"; export default async function Page() { await auth[key as "getCurrentSession"](); }',
  },
  {
    name: "external wrapper invoked through .call(null)",
    source:
      'import { readViewer } from "@/server/auth/fixtures/session-guards/wrapper"; export default async function Page() { await readViewer.call(null); }',
  },
  {
    name: "external wrapper passed as an argument",
    source:
      'import { readViewer } from "@/server/auth/fixtures/session-guards/wrapper"; const run = (fn: () => unknown) => fn(); export default async function Page() { await run(readViewer); }',
  },
];
const FIXTURE_IMPORT_DIR = "@/server/auth/fixtures/session-guards";
const FIXTURE_FILE_DIR = "src/server/auth/fixtures/session-guards";
const SESSION_IMPORT = 'import { getCurrentSession } from "@/server/auth/session";';
const WRAP = "const wrap = <T,>(fn: T): T => fn;";
const helperFiles: Record<string, string> = {};
const helperFixture = (
  name: string,
  helperBody: string,
  pageBody: (helperSpecifier: string) => string,
) => {
  const slug = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  helperFiles[`${FIXTURE_FILE_DIR}/${slug}.ts`] = `${SESSION_IMPORT} ${WRAP} ${helperBody}`;
  return { name, source: pageBody(`${FIXTURE_IMPORT_DIR}/${slug}`) };
};
const callDefault = (call: string) => (specifier: string) =>
  `import viewer from "${specifier}"; export default async function Page() { ${call} }`;

bypasses.push(
  helperFixture(
    "default export of a wrapped arrow",
    "export default wrap(async () => getCurrentSession());",
    callDefault("await viewer();"),
  ),
  helperFixture(
    "default export of an arrow",
    "export default async () => getCurrentSession();",
    callDefault("await viewer();"),
  ),
  helperFixture(
    "default export of a parenthesized function expression",
    "export default (function () { return getCurrentSession(); });",
    callDefault("await viewer();"),
  ),
  helperFixture(
    "default export of a wrapped named function expression",
    "export default wrap(async function Viewer() { await getCurrentSession(); return null; });",
    (specifier) =>
      `import Viewer from "${specifier}"; export default function Page() { return <Viewer />; }`,
  ),
  helperFixture(
    "default export of an object literal",
    "export default { viewer: async () => getCurrentSession() };",
    callDefault("await viewer.viewer();"),
  ),
  helperFixture(
    "default export of a class instance",
    "export default new (class { read = () => getCurrentSession(); })();",
    callDefault("await viewer.read();"),
  ),
  helperFixture(
    "default export of a wrapped class expression",
    "export default wrap(class { read = () => getCurrentSession(); });",
    callDefault("await new viewer().read();"),
  ),
  helperFixture(
    "export-equals of an arrow",
    "export = async () => getCurrentSession();",
    (specifier) =>
      `import viewer = require("${specifier}"); export default async function Page() { await viewer(); }`,
  ),
);

const SESSION_MODULE = "@/server/auth/session";
const dynamicImportPage = (body: string, prelude = "") =>
  `${prelude} export default async function Page() { ${body} }`;
const RUN = "const run = (value: unknown) => value;";
bypasses.push(
  {
    name: "dynamic import: getter by property access",
    source: dynamicImportPage(`await (await import("${SESSION_MODULE}")).getCurrentSession();`),
  },
  {
    name: "dynamic import: namespace passed as an argument",
    source: dynamicImportPage(`run(await import("${SESSION_MODULE}"));`, RUN),
  },
  {
    name: "dynamic import: namespace returned from an arrow body",
    source: dynamicImportPage(
      "await load();",
      `const load = async () => import("${SESSION_MODULE}");`,
    ),
  },
  {
    name: "dynamic import: namespace returned from a block",
    source: dynamicImportPage(
      "await load();",
      `const load = async () => { return await import("${SESSION_MODULE}"); };`,
    ),
  },
  {
    name: "dynamic import: namespace spread",
    source: dynamicImportPage(`return { ...(await import("${SESSION_MODULE}")) };`),
  },
  {
    name: "dynamic import: namespace assigned then passed on",
    source: dynamicImportPage(
      `const session = await import("${SESSION_MODULE}"); run(session);`,
      RUN,
    ),
  },
  {
    name: "dynamic import: namespace assigned then returned",
    source: dynamicImportPage(
      "await load();",
      `const load = async () => { const session = await import("${SESSION_MODULE}"); return session; };`,
    ),
  },
  {
    name: "dynamic import: then(run)",
    source: dynamicImportPage(`await import("${SESSION_MODULE}").then(run);`, RUN),
  },
  {
    name: "dynamic import: then callback reads the getter",
    source: dynamicImportPage(
      `await import("${SESSION_MODULE}").then((session) => session.getCurrentSession());`,
    ),
  },
  {
    name: "dynamic import: then callback passes the namespace on",
    source: dynamicImportPage(
      `await import("${SESSION_MODULE}").then((session) => run(session));`,
      RUN,
    ),
  },
  {
    name: "dynamic import: non-literal specifier",
    source: dynamicImportPage("await import(where);", "declare const where: string;"),
  },
  {
    name: "require of the session module",
    source: dynamicImportPage(`const session = require("${SESSION_MODULE}"); return session;`),
  },
);

const acceptedFixtures = [
  helperFixture(
    "default export without a getter",
    "export default async function () { return 1; }",
    callDefault("await viewer();"),
  ),
  {
    name: "dynamic import of the session module for its side effect only",
    source: dynamicImportPage(`await import("${SESSION_MODULE}"); return null;`),
  },
];

const unlistedDirectCalls = [
  "export default async function Page() { await getCurrentSession(); }",
  'import { getCurrentSession as session } from "@/server/auth/session"; export default async function Page() { await session(); }',
  'import * as auth from "@/server/auth/session"; export default async function Page() { await auth.getCurrentSession(); }',
];
const SESSIONLESS_SOURCE = "export default function Page() { return null; }";

// One program for every in-memory fixture: building a TypeScript program per fixture made this
// file take over a minute.
const fixtureSources = [
  ...new Set([
    ...bypasses.map(({ source }) => source),
    ...acceptedFixtures.map(({ source }) => source),
    ...unlistedDirectCalls,
    SESSIONLESS_SOURCE,
  ]),
];
const fixtureKinds = ["page", "layout"];
const fixturePath = (source: string, kind: string): string =>
  `src/app/fixtures/${fixtureSources.indexOf(source)}/${kind}.tsx`;
const scanFixtures = createSessionGetterScanner({
  ...helperFiles,
  ...Object.fromEntries(
    fixtureSources.flatMap((source) =>
      fixtureKinds.map((kind) => [fixturePath(source, kind), source]),
    ),
  ),
});
const sessionCallLines = (text: string, file: string): number[] => {
  if (pages.includes(file)) return scanRepositorySessions(file);
  const kind = file.endsWith("layout.tsx") ? "layout" : "page";
  return scanFixtures(fixturePath(text, kind));
};

describe("direct page session enumeration", () => {
  it("includes every layout in the candidate population", () => {
    for (const file of [
      "src/app/layout.tsx",
      "src/app/admin/layout.tsx",
      "src/app/finance/layout.tsx",
    ])
      expect(pages).toContain(file);
  });
  for (const kind of ["page", "layout"]) {
    it.each(bypasses)(`detects $name in ${kind}.tsx`, ({ source }) => {
      expect(sessionCallLines(source, `src/app/new/${kind}.tsx`).length).toBeGreaterThan(0);
    });
  }
  for (const kind of ["page", "layout"]) {
    it.each(acceptedFixtures)(`passes $name in ${kind}.tsx`, ({ source }) => {
      expect(sessionCallLines(source, `src/app/new/${kind}.tsx`)).toEqual([]);
    });
  }
  it("enumerates a nonempty page population", () => expect(pages.length).toBeGreaterThan(0));
  it("permits direct session calls only in explicitly reasoned pages", () => {
    expect(
      pages.filter(
        (file) =>
          sessionCallLines(readFileSync(file, "utf8"), file).length > 0 &&
          !Object.hasOwn(SESSION_PAGES, file),
      ),
    ).toEqual([]);
  });
  it.each(Object.entries(SESSION_PAGES))(
    "%s has a live call and a nonempty reason",
    (file, reason) => {
      expect(typeof reason).toBe("string");
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(pages).toContain(file);
      expect(sessionCallLines(readFileSync(file, "utf8"), file).length).toBeGreaterThan(0);
    },
  );
  describe("accepted cases", () => {
    const pageGuard = [
      'import { getCurrentSession } from "@/server/auth/session";',
      "export const requireRolePage = async (role: string) => { await getCurrentSession(); return role; };",
      "export const requireActiveSessionPage = async () => getCurrentSession();",
      "export const requireSneakyPage = async () => getCurrentSession();",
    ].join("\n");
    const scanWithPageGuard = (source: string): number[] =>
      createSessionGetterScanner({
        "src/app/new/page.tsx": source,
        "src/server/auth/page-guard.ts": pageGuard,
      })("src/app/new/page.tsx");
    it("passes a page that only uses the two exempt page guards", () => {
      expect(
        scanWithPageGuard(
          'import { requireRolePage, requireActiveSessionPage } from "@/server/auth/page-guard"; export default async function Page() { await requireRolePage("candidate"); await requireActiveSessionPage(); }',
        ),
      ).toEqual([]);
    });
    it("does not extend the page-guard exemption to any other export of that file", () => {
      expect(
        scanWithPageGuard(
          'import { requireSneakyPage } from "@/server/auth/page-guard"; export default async function Page() { await requireSneakyPage(); }',
        ).length,
      ).toBeGreaterThan(0);
    });
    it("passes a page that reads no session at all", () => {
      expect(sessionCallLines(SESSIONLESS_SOURCE, "src/app/new/page.tsx")).toEqual([]);
    });
  });
  describe("production files", () => {
    const leak =
      '\nimport { getCurrentSession as leakedGetter } from "@/server/auth/session";\nexport const leaked = leakedGetter satisfies unknown;\n';
    const unlistedPage = pages.find(
      (file) => file.endsWith("/page.tsx") && !Object.hasOwn(SESSION_PAGES, file),
    ) as string;
    const unlistedLayout = "src/app/admin/layout.tsx";
    it.each([unlistedPage, unlistedLayout])("%s is clean as committed", (file) => {
      expect(sessionCallLines(readFileSync(file, "utf8"), file)).toEqual([]);
    });
    it.each([unlistedPage, unlistedLayout])("%s fails once a getter reference is added", (file) => {
      const modified = readFileSync(file, "utf8") + leak;
      expect(createSessionGetterScanner({ [file]: modified })(file).length).toBeGreaterThan(0);
    });
  });
  it.each(unlistedDirectCalls)("detects an unlisted direct call: %s", (source) => {
    expect(sessionCallLines(source, "src/app/new/page.tsx")).toEqual([1]);
  });
});
