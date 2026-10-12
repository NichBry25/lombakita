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
const sessionCallLines = (text: string, file: string): number[] => {
  if (pages.includes(file)) return scanRepositorySessions(file);
  return createSessionGetterScanner({ [file]: text })(file);
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
  for (const kind of ["page", "layout"]) {
    it.each(bypasses)(`detects $name in ${kind}.tsx`, ({ source }) => {
      expect(sessionCallLines(source, `src/app/new/${kind}.tsx`).length).toBeGreaterThan(0);
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
      expect(
        sessionCallLines("export default function Page() { return null; }", "src/app/new/page.tsx"),
      ).toEqual([]);
    });
  });
  it.each([
    "export default async function Page() { await getCurrentSession(); }",
    'import { getCurrentSession as session } from "@/server/auth/session"; export default async function Page() { await session(); }',
    'import * as auth from "@/server/auth/session"; export default async function Page() { await auth.getCurrentSession(); }',
  ])("detects an unlisted direct call: %s", (source) => {
    expect(sessionCallLines(source, "src/app/new/page.tsx")).toEqual([1]);
  });
});
