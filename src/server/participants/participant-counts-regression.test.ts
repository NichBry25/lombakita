// @vitest-environment node
//
// The organiser summary has no "pending" column. Paid registrations insert as `confirmed`
// (DEC-0175), so no production path writes `pending_payment` and a count of it is zero forever.
// A guard over that literal stayed green over a number that could never be non-zero, so these
// assertions pin the column's absence instead.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PARTICIPANTS_PAGE =
  "src/app/institution/[institutionSlug]/competitions/[competitionSlug]/participants/page.tsx";

describe("organiser participant summary — no pending column", () => {
  it("the aggregate counts query selects no pending count", () => {
    const source = readFileSync(resolve("src/server/participants/participant-service.ts"), "utf-8");

    expect(source).not.toMatch(/\bpending:\s*sql/);
    expect(source).not.toContain("= 'pending_payment'");
  });

  it("the organiser page renders no Menunggu summary stat and reads no pending count", () => {
    const source = readFileSync(resolve(PARTICIPANTS_PAGE), "utf-8");

    expect(source).not.toContain("<span>Menunggu</span>");
    expect(source).not.toContain("counts.pending");
  });
});
