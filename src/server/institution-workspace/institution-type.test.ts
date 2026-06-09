// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { InstitutionType } from "@/server/db/schema";
import {
  assertInstitutionTypeTransition,
  FULL_INSTITUTION_TYPES,
  InstitutionTypeTransitionError,
  isFullInstitution,
  isFullInstitutionType,
  isInstitutionType,
  isPersonalInstitutionType,
  MAX_PERSONAL_INSTITUTIONS_PER_RECRUITER,
  MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL,
  PERSONAL_INSTITUTION_TYPE,
} from "@/server/institution-workspace/institution-type";

const FULL: InstitutionType[] = ["company", "foundation", "university", "campus_organization"];
const PERSONAL: InstitutionType = "personal";
const ALL_NEXT: InstitutionType[] = [PERSONAL, ...FULL];
const ALL_CURRENT: (InstitutionType | null)[] = [null, PERSONAL, ...FULL];

const isAllowed = (current: InstitutionType | null, next: InstitutionType): boolean => {
  try {
    assertInstitutionTypeTransition(current, next);
    return true;
  } catch {
    return false;
  }
};

// The single source of truth for the expected verdict of every cell — derived independently from
// the rules (not from the implementation) so the matrix test is a real oracle.
const expectedAllowed = (current: InstitutionType | null, next: InstitutionType): boolean => {
  if (current === next) return true; // same → same no-op
  if (next === PERSONAL) return false; // anything → personal forbidden
  if (current === null) return true; // NULL → full subtype (legacy first-declaration)
  if (current === PERSONAL) return true; // personal → full (upgrade)
  return false; // full → different full forbidden
};

describe("institution-type predicates", () => {
  it("isPersonalInstitutionType: only 'personal' is personal; NULL is not", () => {
    expect(isPersonalInstitutionType("personal")).toBe(true);
    expect(isPersonalInstitutionType(null)).toBe(false);
    for (const t of FULL) expect(isPersonalInstitutionType(t)).toBe(false);
  });

  it("isFullInstitution: everything that is not 'personal' (incl NULL) is full", () => {
    expect(isFullInstitution(null)).toBe(true);
    expect(isFullInstitution("personal")).toBe(false);
    for (const t of FULL) expect(isFullInstitution(t)).toBe(true);
  });

  it("isFullInstitutionType: the four declared subtypes only", () => {
    for (const t of FULL) expect(isFullInstitutionType(t)).toBe(true);
    expect(isFullInstitutionType("personal")).toBe(false);
    expect(isFullInstitutionType("community")).toBe(false);
    expect(isFullInstitutionType(null)).toBe(false);
  });

  it("isInstitutionType: validates the taxonomy and rejects unknowns", () => {
    for (const t of ALL_NEXT) expect(isInstitutionType(t)).toBe(true);
    expect(isInstitutionType("community")).toBe(false);
    expect(isInstitutionType("")).toBe(false);
    expect(isInstitutionType(null)).toBe(false);
    expect(isInstitutionType(42)).toBe(false);
  });

  it("FULL_INSTITUTION_TYPES excludes personal and community", () => {
    expect(FULL_INSTITUTION_TYPES).not.toContain("personal");
    expect(FULL_INSTITUTION_TYPES).not.toContain("community");
    expect([...FULL_INSTITUTION_TYPES].sort()).toEqual(
      ["campus_organization", "company", "foundation", "university"].sort(),
    );
  });

  it("reach-cap constants are locked", () => {
    expect(MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL).toBe(2);
    expect(MAX_PERSONAL_INSTITUTIONS_PER_RECRUITER).toBe(1);
    expect(PERSONAL_INSTITUTION_TYPE).toBe("personal");
  });
});

describe("assertInstitutionTypeTransition — exhaustive transition matrix", () => {
  // Every (current, next) cell, asserted against the independent oracle.
  for (const current of ALL_CURRENT) {
    for (const next of ALL_NEXT) {
      const label = `${current === null ? "NULL" : current} -> ${next}`;
      const allowed = expectedAllowed(current, next);
      it(`${label} is ${allowed ? "allowed" : "forbidden"}`, () => {
        expect(isAllowed(current, next)).toBe(allowed);
      });
    }
  }

  it("NULL -> any full subtype is allowed (legacy first-declaration)", () => {
    for (const next of FULL) {
      expect(() => assertInstitutionTypeTransition(null, next)).not.toThrow();
    }
  });

  it("personal -> any full subtype is allowed (upgrade)", () => {
    for (const next of FULL) {
      expect(() => assertInstitutionTypeTransition("personal", next)).not.toThrow();
    }
  });

  it("every full subtype -> every OTHER full subtype is forbidden", () => {
    for (const current of FULL) {
      for (const next of FULL) {
        if (current === next) continue;
        expect(() => assertInstitutionTypeTransition(current, next)).toThrow(
          InstitutionTypeTransitionError,
        );
      }
    }
  });

  it("anything -> personal is forbidden except the personal->personal no-op", () => {
    for (const current of ALL_CURRENT) {
      if (current === "personal") {
        expect(() => assertInstitutionTypeTransition(current, "personal")).not.toThrow();
      } else {
        expect(() => assertInstitutionTypeTransition(current, "personal")).toThrow(
          InstitutionTypeTransitionError,
        );
      }
    }
  });

  it("same -> same is a permitted no-op for every concrete type", () => {
    for (const t of ALL_NEXT) {
      expect(() => assertInstitutionTypeTransition(t, t)).not.toThrow();
    }
  });

  it("fails closed on an unknown target type", () => {
    expect(() =>
      assertInstitutionTypeTransition(null, "community" as unknown as InstitutionType),
    ).toThrow(InstitutionTypeTransitionError);
    expect(() =>
      assertInstitutionTypeTransition("personal", "" as unknown as InstitutionType),
    ).toThrow(InstitutionTypeTransitionError);
  });

  it("fails closed on an unknown current type", () => {
    expect(() =>
      assertInstitutionTypeTransition("legacy_admin" as unknown as InstitutionType, "company"),
    ).toThrow(InstitutionTypeTransitionError);
  });

  it("carries the offending pair in the error details", () => {
    try {
      assertInstitutionTypeTransition("company", "foundation");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InstitutionTypeTransitionError);
      const e = err as InstitutionTypeTransitionError;
      expect(e.code).toBe("institution_type_transition_forbidden");
      expect(e.status).toBe(409);
      expect(e.details).toEqual({ currentType: "company", nextType: "foundation" });
    }
  });
});
