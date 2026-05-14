// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  computeAgeYears,
  ELIGIBILITY_MAX_AGE,
  ELIGIBILITY_MIN_AGE,
  EligibilityInputError,
  evaluateEligibility,
  parseEligibilityProfileUpdatePatch,
  type EligibilityProfileSnapshot,
} from "@/server/eligibility/eligibility-core";

const REFERENCE_DATE = new Date("2026-05-09T12:00:00.000Z");

const baseSnapshot = (
  overrides: Partial<EligibilityProfileSnapshot> = {},
): EligibilityProfileSnapshot => ({
  dateOfBirth: "2000-01-15",
  enrollmentStatus: "enrolled",
  educationLevel: "S1",
  universityName: "Universitas Indonesia",
  studentIdNumber: "1906345678",
  ...overrides,
});

describe("computeAgeYears", () => {
  it("returns full years when birthday has passed this year", () => {
    expect(
      computeAgeYears(new Date("2000-01-15T00:00:00.000Z"), new Date("2026-05-09T00:00:00.000Z")),
    ).toBe(26);
  });

  it("subtracts one when birthday has not yet occurred this year", () => {
    expect(
      computeAgeYears(new Date("2000-12-15T00:00:00.000Z"), new Date("2026-05-09T00:00:00.000Z")),
    ).toBe(25);
  });

  it("returns the same age on the day-of birthday (inclusive)", () => {
    expect(
      computeAgeYears(new Date("2000-05-09T00:00:00.000Z"), new Date("2026-05-09T00:00:00.000Z")),
    ).toBe(26);
  });
});

describe("evaluateEligibility — eligible path", () => {
  it("returns eligible when all fields valid and age is in range", () => {
    const result = evaluateEligibility(baseSnapshot(), REFERENCE_DATE);

    expect(result.status).toBe("eligible");
    expect(result.reasons).toEqual([]);
    expect(result.checkedAt).toBe(REFERENCE_DATE);
  });

  it("treats exactly the minimum age (18 today) as eligible", () => {
    // Born exactly 18 years ago today.
    const dob = `${REFERENCE_DATE.getUTCFullYear() - ELIGIBILITY_MIN_AGE}-${String(
      REFERENCE_DATE.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(REFERENCE_DATE.getUTCDate()).padStart(2, "0")}`;

    const result = evaluateEligibility(baseSnapshot({ dateOfBirth: dob }), REFERENCE_DATE);

    expect(result.status).toBe("eligible");
    expect(result.reasons).toEqual([]);
  });

  it("treats exactly the maximum age (32 today) as eligible", () => {
    const dob = `${REFERENCE_DATE.getUTCFullYear() - ELIGIBILITY_MAX_AGE}-${String(
      REFERENCE_DATE.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(REFERENCE_DATE.getUTCDate()).padStart(2, "0")}`;

    const result = evaluateEligibility(baseSnapshot({ dateOfBirth: dob }), REFERENCE_DATE);

    expect(result.status).toBe("eligible");
    expect(result.reasons).toEqual([]);
  });
});

describe("evaluateEligibility — ineligible_age path", () => {
  it("flags age_below_minimum when student is exactly 17 today", () => {
    const dob = `${REFERENCE_DATE.getUTCFullYear() - 17}-${String(
      REFERENCE_DATE.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(REFERENCE_DATE.getUTCDate()).padStart(2, "0")}`;

    const result = evaluateEligibility(baseSnapshot({ dateOfBirth: dob }), REFERENCE_DATE);

    expect(result.status).toBe("ineligible_age");
    expect(result.reasons).toEqual(["age_below_minimum"]);
  });

  it("flags age_below_minimum when student turns 18 tomorrow", () => {
    // Birthday is one day after the reference date — age = 17 today.
    const tomorrow = new Date(REFERENCE_DATE);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const dob = `${tomorrow.getUTCFullYear() - 18}-${String(tomorrow.getUTCMonth() + 1).padStart(
      2,
      "0",
    )}-${String(tomorrow.getUTCDate()).padStart(2, "0")}`;

    const result = evaluateEligibility(baseSnapshot({ dateOfBirth: dob }), REFERENCE_DATE);

    expect(result.status).toBe("ineligible_age");
    expect(result.reasons).toContain("age_below_minimum");
  });

  it("flags age_above_maximum when student is exactly 33 today", () => {
    const dob = `${REFERENCE_DATE.getUTCFullYear() - 33}-${String(
      REFERENCE_DATE.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(REFERENCE_DATE.getUTCDate()).padStart(2, "0")}`;

    const result = evaluateEligibility(baseSnapshot({ dateOfBirth: dob }), REFERENCE_DATE);

    expect(result.status).toBe("ineligible_age");
    expect(result.reasons).toEqual(["age_above_maximum"]);
  });
});

describe("evaluateEligibility — ineligible_enrollment path", () => {
  it("returns ineligible_enrollment with on_leave reason", () => {
    const result = evaluateEligibility(
      baseSnapshot({ enrollmentStatus: "on_leave" }),
      REFERENCE_DATE,
    );

    expect(result.status).toBe("ineligible_enrollment");
    expect(result.reasons).toEqual(["enrollment_status_on_leave"]);
  });

  it("returns ineligible_enrollment with graduated reason", () => {
    const result = evaluateEligibility(
      baseSnapshot({ enrollmentStatus: "graduated" }),
      REFERENCE_DATE,
    );

    expect(result.status).toBe("ineligible_enrollment");
    expect(result.reasons).toEqual(["enrollment_status_graduated"]);
  });

  it("returns ineligible_enrollment with unknown reason", () => {
    const result = evaluateEligibility(
      baseSnapshot({ enrollmentStatus: "unknown" }),
      REFERENCE_DATE,
    );

    expect(result.status).toBe("ineligible_enrollment");
    expect(result.reasons).toEqual(["enrollment_status_unknown"]);
  });
});

describe("evaluateEligibility — incomplete path", () => {
  it("returns incomplete (not ineligible_age) when date_of_birth is missing", () => {
    const result = evaluateEligibility(baseSnapshot({ dateOfBirth: null }), REFERENCE_DATE);

    expect(result.status).toBe("incomplete");
    expect(result.reasons).toEqual(["missing_date_of_birth"]);
  });

  it("returns incomplete with missing_enrollment_status when enrollment is null", () => {
    const result = evaluateEligibility(baseSnapshot({ enrollmentStatus: null }), REFERENCE_DATE);

    expect(result.status).toBe("incomplete");
    expect(result.reasons).toEqual(["missing_enrollment_status"]);
  });

  it("aggregates all missing-field reasons without short-circuit", () => {
    const result = evaluateEligibility(
      {
        dateOfBirth: null,
        enrollmentStatus: null,
        educationLevel: null,
        universityName: null,
        studentIdNumber: null,
      },
      REFERENCE_DATE,
    );

    expect(result.status).toBe("incomplete");
    expect(result.reasons).toEqual([
      "missing_date_of_birth",
      "missing_enrollment_status",
      "missing_education_level",
      "missing_university_name",
      "missing_student_id_number",
    ]);
  });

  it("treats empty/whitespace text fields as missing", () => {
    const result = evaluateEligibility(
      baseSnapshot({ universityName: "   ", studentIdNumber: "" }),
      REFERENCE_DATE,
    );

    expect(result.status).toBe("incomplete");
    expect(result.reasons).toContain("missing_university_name");
    expect(result.reasons).toContain("missing_student_id_number");
  });
});

describe("evaluateEligibility — multi-reason aggregation", () => {
  it("incomplete wins over named ineligibility when fields are missing", () => {
    // Age out-of-range AND enrollment graduated AND missing student_id_number.
    const dob = `${REFERENCE_DATE.getUTCFullYear() - 33}-${String(
      REFERENCE_DATE.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(REFERENCE_DATE.getUTCDate()).padStart(2, "0")}`;

    const result = evaluateEligibility(
      baseSnapshot({
        dateOfBirth: dob,
        enrollmentStatus: "graduated",
        studentIdNumber: null,
      }),
      REFERENCE_DATE,
    );

    expect(result.status).toBe("incomplete");
    expect(result.reasons).toContain("missing_student_id_number");
    expect(result.reasons).toContain("age_above_maximum");
    expect(result.reasons).toContain("enrollment_status_graduated");
  });

  it("ineligible_age takes precedence over ineligible_enrollment when both apply (no missing fields)", () => {
    const dob = `${REFERENCE_DATE.getUTCFullYear() - 33}-${String(
      REFERENCE_DATE.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(REFERENCE_DATE.getUTCDate()).padStart(2, "0")}`;

    const result = evaluateEligibility(
      baseSnapshot({ dateOfBirth: dob, enrollmentStatus: "graduated" }),
      REFERENCE_DATE,
    );

    expect(result.status).toBe("ineligible_age");
    expect(result.reasons).toContain("age_above_maximum");
    expect(result.reasons).toContain("enrollment_status_graduated");
  });
});

describe("parseEligibilityProfileUpdatePatch", () => {
  it("normalizes valid input fields", () => {
    const patch = parseEligibilityProfileUpdatePatch({
      dateOfBirth: "2002-03-21",
      enrollmentStatus: "enrolled",
      educationLevel: "S1",
      universityName: "  Universitas Gadjah Mada  ",
      studentIdNumber: "  19/445566/SV/01234  ",
    });

    expect(patch).toEqual({
      dateOfBirth: "2002-03-21",
      enrollmentStatus: "enrolled",
      educationLevel: "S1",
      universityName: "Universitas Gadjah Mada",
      studentIdNumber: "19/445566/SV/01234",
    });
  });

  it("allows clearing optional fields with null or empty string", () => {
    const patch = parseEligibilityProfileUpdatePatch({
      universityName: null,
      studentIdNumber: "   ",
      dateOfBirth: "",
    });

    expect(patch).toEqual({
      universityName: null,
      studentIdNumber: null,
      dateOfBirth: null,
    });
  });

  it("rejects status field as protected", () => {
    expect(() =>
      parseEligibilityProfileUpdatePatch({ status: "eligible" }),
    ).toThrowError(EligibilityInputError);

    try {
      parseEligibilityProfileUpdatePatch({ status: "eligible" });
    } catch (error) {
      const typed = error as EligibilityInputError;
      expect(typed.code).toBe("eligibility_protected_fields");
      expect(typed.details?.fields).toContain("status");
    }
  });

  it("rejects reasons field as protected", () => {
    expect(() =>
      parseEligibilityProfileUpdatePatch({ reasons: ["age_below_minimum"] }),
    ).toThrowError(EligibilityInputError);
  });

  it("rejects unknown fields", () => {
    try {
      parseEligibilityProfileUpdatePatch({ favoriteColor: "blue" });
    } catch (error) {
      const typed = error as EligibilityInputError;
      expect(typed.code).toBe("eligibility_invalid_fields");
      expect(typed.details?.fields).toContain("favoriteColor");
    }
  });

  it("rejects malformed date_of_birth", () => {
    expect(() =>
      parseEligibilityProfileUpdatePatch({ dateOfBirth: "31-12-2000" }),
    ).toThrowError(/dateOfBirth must be a YYYY-MM-DD string/);
  });

  it("rejects future date_of_birth", () => {
    const next = new Date();
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    const futureDob = `${next.getUTCFullYear()}-01-01`;

    expect(() =>
      parseEligibilityProfileUpdatePatch({ dateOfBirth: futureDob }),
    ).toThrowError(/dateOfBirth must be a YYYY-MM-DD string in the past/);
  });

  it("rejects unknown enrollment status enum value", () => {
    expect(() =>
      parseEligibilityProfileUpdatePatch({ enrollmentStatus: "expelled" }),
    ).toThrowError(/enrollmentStatus must be one of/);
  });

  it("rejects unknown education level enum value", () => {
    expect(() =>
      parseEligibilityProfileUpdatePatch({ educationLevel: "PhD" }),
    ).toThrowError(/educationLevel must be one of/);
  });

  it("rejects empty payload", () => {
    expect(() => parseEligibilityProfileUpdatePatch({})).toThrowError(
      /At least one editable eligibility field is required/,
    );
  });

  it("rejects non-object payloads", () => {
    expect(() => parseEligibilityProfileUpdatePatch("hello")).toThrowError(
      EligibilityInputError,
    );
    expect(() => parseEligibilityProfileUpdatePatch([1, 2, 3])).toThrowError(
      EligibilityInputError,
    );
    expect(() => parseEligibilityProfileUpdatePatch(null)).toThrowError(EligibilityInputError);
  });
});
