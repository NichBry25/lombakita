// @vitest-environment node
//
// What the deploy gate's command line DECLARES.
//
// `--environment` does two jobs: it names the file `vercel pull` wrote, and it is the only statement
// anyone makes about which environment this run is for. The identity check is handed the second job
// and nothing else, so this mapping is where a deploy gate's expectation comes from — and a mapping
// that declared nothing would leave the check silently not running, which is the fail-open shape the
// check exists to remove.

import { describe, expect, it } from "vitest";

import { declaredEnvironmentFromFlag } from "@/server/scripts/connectors-status";

describe("declaredEnvironmentFromFlag", () => {
  it("passes preview through as a declared environment", () => {
    expect(declaredEnvironmentFromFlag("preview")).toBe("preview");
  });

  it("passes production through as a declared environment", () => {
    expect(declaredEnvironmentFromFlag("production")).toBe("production");
  });

  // Not a refusal: `--environment` still selects an env file for every one of these, and `local` is
  // a real value for it. It is simply not a DECLARED environment, so nothing is passed on and the
  // identity check is left with no expectation rather than an interpreted one.
  it("passes nothing for any other value", () => {
    expect(declaredEnvironmentFromFlag("staging")).toBeUndefined();
    expect(declaredEnvironmentFromFlag("local")).toBeUndefined();
    expect(declaredEnvironmentFromFlag("Preview")).toBeUndefined();
    expect(declaredEnvironmentFromFlag("")).toBeUndefined();
    expect(declaredEnvironmentFromFlag(undefined)).toBeUndefined();
  });
});
