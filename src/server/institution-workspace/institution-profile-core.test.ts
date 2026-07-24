// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseInstitutionProfileInput,
  InstitutionProfileInputError,
} from "@/server/institution-workspace/institution-profile-core";

describe("parseInstitutionProfileInput", () => {
  it("parses a full valid profile", () => {
    const input = parseInstitutionProfileInput({
      about: "  Kami penyelenggara.  ",
      contactName: "Budi",
      contactEmail: "panitia@kampus.ac.id",
      contactPhone: "+62 812 0000",
      websiteUrl: "https://kampus.ac.id",
      socialLinks: [
        { platform: "instagram", url: "https://instagram.com/kampus" },
        { platform: "linkedin", url: "https://linkedin.com/company/kampus" },
      ],
    });

    expect(input.about).toBe("Kami penyelenggara.");
    expect(input.contactEmail).toBe("panitia@kampus.ac.id");
    expect(input.websiteUrl).toBe("https://kampus.ac.id");
    expect(input.socialLinks).toHaveLength(2);
  });

  it("coerces blank scalar fields to null", () => {
    const input = parseInstitutionProfileInput({
      about: "   ",
      contactName: "",
      contactEmail: null,
      contactPhone: undefined,
      websiteUrl: "",
      socialLinks: [],
    });
    expect(input.about).toBeNull();
    expect(input.contactName).toBeNull();
    expect(input.contactEmail).toBeNull();
    expect(input.contactPhone).toBeNull();
    expect(input.websiteUrl).toBeNull();
    expect(input.socialLinks).toEqual([]);
  });

  it("defaults to an empty profile when no fields are provided", () => {
    const input = parseInstitutionProfileInput({});
    expect(input).toEqual({
      about: null,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      websiteUrl: null,
      socialLinks: [],
    });
  });

  it("rejects a non-object payload", () => {
    expect(() => parseInstitutionProfileInput(null)).toThrow(InstitutionProfileInputError);
    expect(() => parseInstitutionProfileInput("x")).toThrow(/JSON object/);
  });

  it("rejects unsupported fields", () => {
    try {
      parseInstitutionProfileInput({ about: "ok", verificationStatus: "verified" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InstitutionProfileInputError);
      expect((error as InstitutionProfileInputError).code).toBe(
        "institution_profile_invalid_fields",
      );
      expect((error as InstitutionProfileInputError).details?.fields).toContain(
        "verificationStatus",
      );
    }
  });

  it("rejects a malformed email", () => {
    expect(() => parseInstitutionProfileInput({ contactEmail: "not-an-email" })).toThrow(
      /valid email/,
    );
  });

  it("rejects a non-http(s) website URL", () => {
    expect(() => parseInstitutionProfileInput({ websiteUrl: "ftp://kampus.ac.id" })).toThrow(
      /valid http/,
    );
  });

  it("skips a social link with a blank url", () => {
    const input = parseInstitutionProfileInput({
      socialLinks: [
        { platform: "instagram", url: "" },
        { platform: "x", url: "https://x.com/kampus" },
      ],
    });
    expect(input.socialLinks).toEqual([{ platform: "x", url: "https://x.com/kampus" }]);
  });

  it("rejects an unknown social platform", () => {
    expect(() =>
      parseInstitutionProfileInput({
        socialLinks: [{ platform: "myspace", url: "https://m.com" }],
      }),
    ).toThrow(/platform must be one of/);
  });

  it("rejects duplicate social platforms", () => {
    expect(() =>
      parseInstitutionProfileInput({
        socialLinks: [
          { platform: "x", url: "https://x.com/a" },
          { platform: "x", url: "https://x.com/b" },
        ],
      }),
    ).toThrow(/duplicate social link/);
  });

  it("rejects a non-array socialLinks", () => {
    expect(() => parseInstitutionProfileInput({ socialLinks: "nope" })).toThrow(/must be an array/);
  });
});
