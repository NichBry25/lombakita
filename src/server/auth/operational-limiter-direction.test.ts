// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `server/redis/rate-limit.ts` exports two fixed-window limiters that differ ONLY in what they do
// when Redis cannot answer. `checkFixedWindowLimit` fails OPEN, which is right for a self-service
// surface: a Redis blip must not lock every candidate out of sign-in. `checkFixedWindowLimitFailClosed`
// fails CLOSED, which is right for an operational one: refusing platform_ops access during an outage
// is the shipped position (DEC-0112, DEC-0134), and a limiter that silently stops limiting is worse
// than none because it reports success.
//
// The two names sit one line apart in an editor's autocomplete, and importing the wrong one produces
// no type error, no lint warning and no test failure — the surface behaves identically until the
// moment Redis is unreachable, which is the moment it matters. A source scan is the instrument
// because the failure mode is a call site nobody thought to write a test for, and the property has
// to hold over the whole tree rather than at the sites that exist today.

const OPERATIONAL_LIMITER_ROOTS = ["src/server/auth/mfa", "src/app/api/v1/auth/mfa"] as const;
const FAIL_OPEN_LIMITER = "checkFixedWindowLimit";
const FAIL_CLOSED_LIMITER = "checkFixedWindowLimitFailClosed";

const collectSourceFiles = (dir: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(path));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
};

// `checkFixedWindowLimitFailClosed` contains `checkFixedWindowLimit` as a prefix, so a plain
// `includes` matches both and the scan would pass on the very import it exists to catch.
const importsFailOpenLimiter = (source: string): boolean =>
  new RegExp(`\\b${FAIL_OPEN_LIMITER}(?!FailClosed)\\b`).test(source);

describe("operational surfaces use the fail-CLOSED limiter", () => {
  const sourceFiles = OPERATIONAL_LIMITER_ROOTS.flatMap((root) => collectSourceFiles(root));

  it("finds the operational trees, so an empty scan cannot pass silently", () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(5);
  });

  it.each(sourceFiles)("%s does not reach for the fail-open limiter", (file) => {
    const source = readFileSync(file, "utf8");

    expect(
      importsFailOpenLimiter(source),
      `${file} references ${FAIL_OPEN_LIMITER}, which ALLOWS when Redis is unreachable. ` +
        `Operational surfaces must use ${FAIL_CLOSED_LIMITER}: on this path a limiter that stops ` +
        `limiting during an outage removes the ceiling at exactly the moment an attacker wants it ` +
        `gone, and reports success while doing it.`,
    ).toBe(false);
  });

  it("confirms the MFA route guard is limited at all, so passing by absence is not possible", () => {
    const guard = readFileSync("src/server/auth/mfa/mfa-route-guard.ts", "utf8");

    // Without this, deleting the limiter entirely would satisfy every assertion above — the scan
    // proves the direction is right, this proves there is a direction to be right about.
    expect(guard).toContain(FAIL_CLOSED_LIMITER);
  });
});
