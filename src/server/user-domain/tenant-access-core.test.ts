import { describe, expect, it } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import {
  assertInstitutionMembership,
  assertInstitutionRole,
  pickInstitutionMembership,
} from "@/server/user-domain/tenant-access-core";

const membershipFixture = {
  membershipId: "m_1",
  institutionId: "inst_1",
  institutionSlug: "binus",
  institutionDisplayName: "BINUS",
  institutionStatus: "active",
  membershipRole: "institution_owner",
  membershipStatus: "active",
  joinedAt: new Date("2026-01-01T00:00:00.000Z"),
} as const;

describe("tenant-access-core", () => {
  it("picks membership by institution id", () => {
    const membership = pickInstitutionMembership([membershipFixture], "inst_1");

    expect(membership?.membershipId).toBe("m_1");
  });

  it("throws when membership is missing", () => {
    expect(() => assertInstitutionMembership(null)).toThrow(AccessError);
  });

  it("throws when membership is not active", () => {
    expect(() =>
      assertInstitutionMembership({
        ...membershipFixture,
        membershipStatus: "inactive",
      }),
    ).toThrowError(/Institution membership required/i);
  });

  it("throws for disallowed institution role", () => {
    const activeMembership = assertInstitutionMembership(membershipFixture);

    expect(() => assertInstitutionRole(activeMembership, ["institution_staff"])).toThrowError(
      /Insufficient institution role/i,
    );
  });

  it("passes for allowed institution role", () => {
    const activeMembership = assertInstitutionMembership(membershipFixture);
    const verified = assertInstitutionRole(activeMembership, [
      "institution_owner",
      "institution_staff",
    ]);

    expect(verified.membershipRole).toBe("institution_owner");
  });
});
