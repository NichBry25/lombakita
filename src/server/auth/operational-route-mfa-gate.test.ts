// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The MFA requirement for operational accounts lives in exactly two choke points —
// `assertSessionRole` (API) and `requireRolePage` (pages) — so a route that enforces
// `platform_ops` WITHOUT passing through one of them is role-gated but NOT MFA-gated, and an
// operational session sitting in `enrolment_required` / `challenge_required` still reaches it.
//
// That is not hypothetical: the three `/api/admin/institutions/*` routes did exactly this. They
// checked the role at the SERVICE layer (`requirePlatformOps(actorRole)`) after only
// `requireAuthenticatedSession()`, so they refused the right callers for the right reason while
// silently sitting outside the gate. They were also the reason two audits of "the platform-ops
// routes" disagreed on the count: one walked `api/platform-ops/`, the other included `api/admin/`.
//
// A source scan rather than a per-route test, because the failure mode is a route nobody thought
// to write a test for. This asserts the property over the whole tree, so the NEXT operational route
// added under either prefix cannot reopen the hole by omission.

const OPERATIONAL_ROUTE_ROOTS = ["src/app/api/platform-ops", "src/app/api/admin"] as const;
const CHOKE_POINT_IMPORTS = ["requireSessionRole", "withApiRole"] as const;

const collectRouteFiles = (dir: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectRouteFiles(path));
    } else if (entry.name === "route.ts") {
      found.push(path);
    }
  }
  return found;
};

describe("operational API routes reach the MFA choke point", () => {
  const routeFiles = OPERATIONAL_ROUTE_ROOTS.flatMap((root) => collectRouteFiles(root));

  it("finds every operational route tree, so an empty scan cannot pass silently", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(20);
  });

  it.each(routeFiles)("%s enforces its role through assertSessionRole", (file) => {
    const source = readFileSync(file, "utf8");
    const usesChokePoint = CHOKE_POINT_IMPORTS.some((name) => source.includes(name));

    expect(
      usesChokePoint,
      `${file} must gate on requireSessionRole or withApiRole — both route through assertSessionRole, ` +
        `which is where the operational-account MFA requirement is enforced. A service-layer role ` +
        `check alone refuses the wrong role but lets an un-elevated operational session through.`,
    ).toBe(true);
  });
});
