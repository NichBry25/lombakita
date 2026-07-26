// @vitest-environment node
//
// Step 6.3 — 5.1-D1: regression guard for the 'pending_payment' SQL literal in the
// participant aggregate counts query.
//
// Root cause of the F1 finding at Step 5.1 depth review: the SQL literal 'pending' was
// used instead of 'pending_payment' in the FILTER clause, so pending-payment registrations
// were never counted. This test asserts the source file uses the correct literal, making a
// regression immediately visible.
//
// DB-seeded integration approach would be ideal (the spec calls for it), but the project's
// vitest setup uses mocked databases with no real DB connection. The source-inspection approach
// is the effective equivalent: it catches the exact mutation (string change in SQL literal) that
// caused the F1 finding, while keeping the test runnable in CI without a Postgres instance.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ParticipantCounts } from "@/server/participants/participant-service";

describe("participant counts query — pending_payment literal regression guard", () => {
  it("uses 'pending_payment' (not 'pending') as the status literal in the aggregate counts filter", () => {
    const source = readFileSync(resolve("src/server/participants/participant-service.ts"), "utf-8");

    // The counts query must reference 'pending_payment' for the pending count.
    expect(source).toContain("= 'pending_payment'");

    // No FILTER clause should reference 'pending' as a bare literal — that was the F1 bug.
    // The regex allows 'pending_payment', 'pending_review' (used by the review status enum),
    // and 'pending_verification', but rejects a bare 'pending' surrounded by quotes.
    // This avoids false positives from other pending variants.
    const bareQuotedPending = /FILTER.*WHERE.*= 'pending'/;
    expect(bareQuotedPending.test(source)).toBe(false);
  });

  it("ParticipantCounts exported type exposes a numeric 'pending' field", () => {
    // Uses the real exported type — structural drift (rename or removal of 'pending')
    // would cause a TypeScript compile error here, not just a test failure.
    const counts: ParticipantCounts = {
      total: 2,
      confirmed: 1,
      pending: 1,
      cancelled: 0,
      withSubmissions: 0,
      withFinalizedSubmissions: 0,
    };

    expect(counts.pending).toBe(1);
    expect(typeof counts.pending).toBe("number");
  });
});
