// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { assertInstitutionNotSuspended, hasActiveRegistrationsForCompetition } from "./competition-access";
import { CompetitionError } from "./competition-core";

// Build a db.select() chain where .from().where() resolves to the pre-staged row.
const makeCountDb = (count: number) => {
  const where = vi.fn().mockResolvedValue([{ count }]);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select };
};

// Build a db.select() chain ending in .limit() for assertInstitutionNotSuspended.
const makeInstitutionDb = (row: { suspendedAt: Date | null } | null) => {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ limit });
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

describe("assertInstitutionNotSuspended (Step 6.2)", () => {
  it("passes silently when suspended_at is null", async () => {
    const db = makeInstitutionDb({ suspendedAt: null });
    await expect(assertInstitutionNotSuspended("inst_1", db as never)).resolves.toBeUndefined();
  });

  it("throws institution_suspended (403) when suspended_at is set", async () => {
    const db = makeInstitutionDb({ suspendedAt: new Date() });
    await expect(assertInstitutionNotSuspended("inst_1", db as never)).rejects.toMatchObject({
      code: "institution_suspended",
      httpStatus: 403,
    });
  });

  it("throws competition_not_found (404) when the institution does not exist", async () => {
    const db = makeInstitutionDb(null);
    await expect(assertInstitutionNotSuspended("missing", db as never)).rejects.toBeInstanceOf(
      CompetitionError,
    );
  });
});
