// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  getCandidateProfile,
  updateCandidateProfile,
  type CandidateProfileRow,
} from "./candidate-profile-service";

const NOW = new Date("2026-07-22T00:00:00.000Z");

const profileRow = (): CandidateProfileRow => ({
  userId: "u_candidate",
  fullName: "Budi",
  phoneNumber: "+628123456789",
  occupation: "professional",
  dateOfBirth: "1985-01-01",
  createdAt: NOW,
  updatedAt: NOW,
});

// db.select(cols).from().where().limit() → resolves to the queued row set.
const selectDb = (rows: unknown[]) => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows),
      })),
    })),
  })),
});

// db.update().set().where().returning() → resolves to the queued row set.
const updateDb = (rows: unknown[]) => ({
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue(rows),
      })),
    })),
  })),
});

describe("getCandidateProfile — absent-profile read path (OOB-CANDIDACY-T2)", () => {
  afterEach(() => vi.clearAllMocks());

  // A candidate_verified_at account with no candidate_profiles row is a permanent condition:
  // the migration-0015 operational-account carve-out (platform_ops / finance_ops /
  // reviewer_or_judge) satisfies users_one_verified_role_chk without an onboarding profile.
  // The read must return null, never throw and never fabricate a row.
  it("returns null when the account has no candidate_profiles row", async () => {
    const db = selectDb([]);
    const result = await getCandidateProfile("u_carve_out", db as never);
    expect(result).toBeNull();
  });

  it("returns the row when a candidate_profiles row exists", async () => {
    const row = profileRow();
    const db = selectDb([row]);
    const result = await getCandidateProfile("u_candidate", db as never);
    expect(result).toEqual(row);
  });
});

describe("updateCandidateProfile — absent-profile write path (backs the route 404)", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns null when there is no row to update", async () => {
    const db = updateDb([]);
    const result = await updateCandidateProfile("u_carve_out", { fullName: "X" }, db as never);
    expect(result).toBeNull();
  });
});
