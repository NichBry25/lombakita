// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { InstitutionType } from "@/server/db/schema";
import {
  isInstitutionType,
  isPersonalInstitutionType,
  MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL,
  PERSONAL_INSTITUTION_TYPE,
} from "@/server/institution-workspace/institution-type";

const FULL: InstitutionType[] = ["company", "foundation", "university", "campus_organization"];
const PERSONAL: InstitutionType = "personal";
const ALL_NEXT: InstitutionType[] = [PERSONAL, ...FULL];

describe("institution-type predicates", () => {
  it("isPersonalInstitutionType: only 'personal' is personal; NULL is not", () => {
    expect(isPersonalInstitutionType("personal")).toBe(true);
    expect(isPersonalInstitutionType(null)).toBe(false);
    for (const t of FULL) expect(isPersonalInstitutionType(t)).toBe(false);
  });

  it("isInstitutionType: validates the taxonomy and rejects unknowns", () => {
    for (const t of ALL_NEXT) expect(isInstitutionType(t)).toBe(true);
    expect(isInstitutionType("community")).toBe(false);
    expect(isInstitutionType("")).toBe(false);
    expect(isInstitutionType(null)).toBe(false);
    expect(isInstitutionType(42)).toBe(false);
  });

  it("reach-cap constants are locked", () => {
    expect(MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL).toBe(2);
    expect(PERSONAL_INSTITUTION_TYPE).toBe("personal");
  });
});
