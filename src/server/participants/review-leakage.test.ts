// @vitest-environment node
//
// Step 5.2 leakage guard: the institution-internal review fields
// (internal_review_status / internal_notes) must never reach a candidate. The
// candidate own-registration read (getStudentRegistration) uses an explicit column
// allowlist; this test asserts that allowlist does not include the review columns.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/eligibility/eligibility-service", () => ({ checkStudentEligibility: vi.fn() }));

import { getStudentRegistration } from "@/server/registrations/registration-service";

describe("candidate own-registration read does not expose internal review fields", () => {
  it("getStudentRegistration select allowlist omits internalReviewStatus and internalNotes", async () => {
    let captured: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      from: () => chain,
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

    await getStudentRegistration("stud_1", "comp_1", db as never);

    expect(captured).not.toBeNull();
    const keys = Object.keys(captured ?? {});
    expect(keys).not.toContain("internalReviewStatus");
    expect(keys).not.toContain("internalNotes");
  });
});
