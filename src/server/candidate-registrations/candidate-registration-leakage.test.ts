// @vitest-environment node
//
// Step 6.3 — 5.2-D1: Extend leakage coverage to candidate dashboard registration list paths.
//
// The original review-leakage.test.ts (Step 5.2) only covered getStudentRegistration.
// This file asserts that internalReviewStatus and internalNotes are absent from:
//   (a) the candidate dashboard individual registration list (listCandidateIndividualRegistrations)
//   (b) the team candidate read path (listCandidateTeamRegistrations)

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  listCandidateIndividualRegistrations,
  listCandidateTeamRegistrations,
} from "@/server/candidate-registrations/candidate-registration-service";

describe("candidate registration list paths do not expose internal review fields", () => {
  it("listCandidateIndividualRegistrations select allowlist omits internalReviewStatus and internalNotes", async () => {
    let captured: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve([]),
    };
    const db = {
      select: (cols: Record<string, unknown>) => {
        captured = cols;
        return chain;
      },
    };

    await listCandidateIndividualRegistrations("user_1", db as never);

    expect(captured).not.toBeNull();
    const keys = Object.keys(captured ?? {});
    expect(keys).not.toContain("internalReviewStatus");
    expect(keys).not.toContain("internalNotes");
  });

  it("listCandidateTeamRegistrations select allowlist omits internalReviewStatus and internalNotes", async () => {
    let captured: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve([]),
    };
    const db = {
      select: (cols: Record<string, unknown>) => {
        captured = cols;
        return chain;
      },
    };

    await listCandidateTeamRegistrations("user_1", db as never);

    expect(captured).not.toBeNull();
    const keys = Object.keys(captured ?? {});
    expect(keys).not.toContain("internalReviewStatus");
    expect(keys).not.toContain("internalNotes");
  });
});
