// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  StudentProfileInputError,
  parseStudentProfileUpdatePatch,
} from "@/server/student-profile/profile-core";

describe("parseStudentProfileUpdatePatch", () => {
  it("normalizes valid patch payload fields", () => {
    const patch = parseStudentProfileUpdatePatch({
      displayName: "  Aulia Rahman Putri  ",
      phoneNumber: " +62 812-3456-7890 ",
      headline: "  Aktif mengikuti kompetisi teknologi.  ",
    });

    expect(patch).toEqual({
      displayName: "Aulia Rahman Putri",
      phoneNumber: "+6281234567890",
      headline: "Aktif mengikuti kompetisi teknologi.",
    });
  });

  it("rejects protected field updates explicitly", () => {
    expect(() =>
      parseStudentProfileUpdatePatch({
        email: "changed@example.com",
      }),
    ).toThrowError(StudentProfileInputError);

    try {
      parseStudentProfileUpdatePatch({
        email: "changed@example.com",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(StudentProfileInputError);

      const typedError = error as StudentProfileInputError;
      expect(typedError.code).toBe("profile_protected_fields");
      expect(typedError.details?.fields).toContain("email");
    }
  });

  it("rejects invalid phone number formats", () => {
    expect(() =>
      parseStudentProfileUpdatePatch({
        phoneNumber: "08ABCD",
      }),
    ).toThrowError(/phoneNumber must be a valid phone number/i);
  });

  it("allows clearing optional fields", () => {
    const patch = parseStudentProfileUpdatePatch({
      phoneNumber: "",
      headline: "   ",
    });

    expect(patch).toEqual({
      phoneNumber: null,
      headline: null,
    });
  });
});
