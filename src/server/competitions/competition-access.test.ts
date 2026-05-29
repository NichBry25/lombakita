// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { hasActiveRegistrationsForCompetition } from "./competition-access";

// Build a db.select() chain where .from().where() resolves to the pre-staged row.
const makeCountDb = (count: number) => {
  const where = vi.fn().mockResolvedValue([{ count }]);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select };
};

describe("hasActiveRegistrationsForCompetition (Step 4.4 — activated guard)", () => {
  it("returns false when no rows exist", async () => {
    const db = makeCountDb(0);
    const result = await hasActiveRegistrationsForCompetition("comp_1", db as never);
    expect(result).toBe(false);
  });

  it("returns true when at least one non-cancelled row exists", async () => {
    const db = makeCountDb(1);
    const result = await hasActiveRegistrationsForCompetition("comp_1", db as never);
    expect(result).toBe(true);
  });

  it("returns true for a large active count (covers team submission rows)", async () => {
    const db = makeCountDb(5);
    const result = await hasActiveRegistrationsForCompetition("comp_1", db as never);
    expect(result).toBe(true);
  });
});
