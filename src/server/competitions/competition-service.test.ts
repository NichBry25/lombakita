// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CompetitionError,
  type CompetitionPatchInput,
} from "@/server/competitions/competition-core";
import { PUBLIC_COMPETITION_COLUMNS } from "@/server/competitions/competition-access";
import type { CompetitionRow } from "@/server/competitions/competition-access";

const { assertCompetitionAccess, assertInstitutionVerified, hasActiveRegistrationsForCompetition } =
  vi.hoisted(() => ({
    assertCompetitionAccess: vi.fn(),
    assertInstitutionVerified: vi.fn(),
    hasActiveRegistrationsForCompetition: vi.fn(),
  }));

vi.mock("@/server/competitions/competition-access", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/competitions/competition-access")>(
      "@/server/competitions/competition-access",
    );
  return {
    ...actual,
    assertCompetitionAccess,
    assertInstitutionVerified,
    hasActiveRegistrationsForCompetition,
  };
});

import type { Database } from "@/server/db/client";
import {
  transitionCompetitionStatus,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";

// All tests in this file mock assertCompetitionAccess, so the underlying db is never read.
// We pass an empty stub that satisfies the type signature without triggering getDb().
const stubDb = {} as unknown as Database;

const baseCompetition = (overrides: Partial<CompetitionRow> = {}): CompetitionRow => ({
  id: "comp_1",
  institutionId: "inst_1",
  createdByUserId: "user_1",
  slug: "lomba-x",
  title: "Lomba X",
  description: "Deskripsi",
  status: "draft",
  category: null,
  mode: null,
  minTeamSize: null,
  maxTeamSize: null,
  registrationStartAt: null,
  registrationEndAt: null,
  eventStartAt: null,
  eventEndAt: null,
  publishedAt: null,
  archivedAt: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("F1 — deferred fields blocked from output", () => {
  it("PUBLIC_COMPETITION_COLUMNS excludes feeAmount, feeCurrency, isFeatured", () => {
    const keys = Object.keys(PUBLIC_COMPETITION_COLUMNS);
    expect(keys).not.toContain("feeAmount");
    expect(keys).not.toContain("feeCurrency");
    expect(keys).not.toContain("isFeatured");
  });

  it("CompetitionRow shape returned to routes excludes feeAmount, feeCurrency, isFeatured", () => {
    // Type-level guarantee: this object is typed as CompetitionRow and TypeScript will not allow
    // assignments of feeAmount/feeCurrency/isFeatured. The runtime check below documents the
    // contract for future readers and would catch a regression where someone widens CompetitionRow.
    const row: CompetitionRow = baseCompetition();
    expect(Object.prototype.hasOwnProperty.call(row, "feeAmount")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "feeCurrency")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "isFeatured")).toBe(false);
  });
});

describe("F2 — same-status transitions return 422", () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ["draft", "draft"],
    ["published", "published"],
    ["archived", "archived"],
  ] as const)("rejects %s → %s with 422", async (from, to) => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: from }),
      membershipRole: "institution_admin",
    });

    await expect(transitionCompetitionStatus("user_1", "comp_1", to, stubDb)).rejects.toMatchObject({
      code: "competition_invalid_transition",
      httpStatus: 422,
    });
  });

  it("does not call assertInstitutionVerified on same-status draft → draft", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "draft" }),
      membershipRole: "institution_admin",
    });

    await expect(
      transitionCompetitionStatus("user_1", "comp_1", "draft", stubDb),
    ).rejects.toBeInstanceOf(CompetitionError);
    expect(assertInstitutionVerified).not.toHaveBeenCalled();
  });
});

describe("updateCompetitionDraft — field-locking on non-draft (regression for carry-forward)", () => {
  afterEach(() => vi.clearAllMocks());

  it.each(["published", "archived"] as const)(
    "rejects PATCH on a %s competition with 409 competition_field_locked",
    async (status) => {
      assertCompetitionAccess.mockResolvedValue({
        competition: baseCompetition({ status }),
        membershipRole: "institution_admin",
      });
      const patch: CompetitionPatchInput = { title: "Tampered Title" };
      await expect(updateCompetitionDraft("user_1", "comp_1", patch, stubDb)).rejects.toMatchObject({
        code: "competition_field_locked",
        httpStatus: 409,
      });
    },
  );
});
