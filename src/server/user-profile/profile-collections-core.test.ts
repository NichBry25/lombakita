// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  ProfileCollectionError,
  parseCertificationInput,
  parseEducationInput,
  parseExperienceInput,
  parseSkillInput,
  parseSocialLinkInput,
  toDateString,
} from "@/server/user-profile/profile-collections-core";

describe("parseExperienceInput", () => {
  it("accepts a minimal valid experience", () => {
    const input = parseExperienceInput({ title: "Engineer", organizationName: "Acme" });
    expect(input.title).toBe("Engineer");
    expect(input.organizationName).toBe("Acme");
    expect(input.isCurrent).toBe(false);
    expect(input.startDate).toBeNull();
  });

  it("requires title and organizationName", () => {
    expect(() => parseExperienceInput({ organizationName: "Acme" })).toThrow(
      ProfileCollectionError,
    );
    expect(() => parseExperienceInput({ title: "Engineer" })).toThrow(ProfileCollectionError);
  });

  it("parses a YYYY-MM-DD start date to a Date", () => {
    const input = parseExperienceInput({
      title: "Engineer",
      organizationName: "Acme",
      startDate: "2023-01-01",
    });
    expect(input.startDate).toBeInstanceOf(Date);
    expect(toDateString(input.startDate)).toBe("2023-01-01");
  });

  it("forces endDate to null when isCurrent is true", () => {
    const input = parseExperienceInput({
      title: "Engineer",
      organizationName: "Acme",
      isCurrent: true,
      endDate: "2024-01-01",
    });
    expect(input.isCurrent).toBe(true);
    expect(input.endDate).toBeNull();
  });

  it("rejects an endDate before the startDate", () => {
    expect(() =>
      parseExperienceInput({
        title: "Engineer",
        organizationName: "Acme",
        startDate: "2024-01-01",
        endDate: "2023-01-01",
      }),
    ).toThrow(ProfileCollectionError);
  });

  it("rejects a malformed date", () => {
    expect(() =>
      parseExperienceInput({ title: "E", organizationName: "A", startDate: "01-2023" }),
    ).toThrow(ProfileCollectionError);
  });
});

describe("parseEducationInput", () => {
  it("requires a school", () => {
    expect(() => parseEducationInput({ degree: "S1" })).toThrow(ProfileCollectionError);
  });

  it("rejects endYear before startYear", () => {
    expect(() => parseEducationInput({ school: "UI", startYear: 2024, endYear: 2020 })).toThrow(
      ProfileCollectionError,
    );
  });

  it("rejects a year outside the allowed range", () => {
    expect(() => parseEducationInput({ school: "UI", endYear: 1800 })).toThrow(
      ProfileCollectionError,
    );
  });
});

describe("parseSkillInput", () => {
  it("trims and requires a name", () => {
    expect(parseSkillInput({ name: "  Go  " }).name).toBe("Go");
    expect(() => parseSkillInput({ name: "   " })).toThrow(ProfileCollectionError);
  });
});

describe("parseCertificationInput", () => {
  it("requires name and issuer", () => {
    expect(() => parseCertificationInput({ name: "AWS" })).toThrow(ProfileCollectionError);
  });

  it("rejects an invalid credential URL", () => {
    expect(() =>
      parseCertificationInput({ name: "AWS", issuer: "Amazon", credentialUrl: "not-a-url" }),
    ).toThrow(ProfileCollectionError);
  });
});

describe("parseSocialLinkInput", () => {
  it("accepts a known platform with a valid URL", () => {
    const input = parseSocialLinkInput({ platform: "github", url: "https://github.com/x" });
    expect(input.platform).toBe("github");
    expect(input.url).toBe("https://github.com/x");
  });

  it("rejects an unknown platform", () => {
    expect(() => parseSocialLinkInput({ platform: "myspace", url: "https://example.com" })).toThrow(
      ProfileCollectionError,
    );
  });

  it("requires a valid URL", () => {
    expect(() => parseSocialLinkInput({ platform: "website", url: "nope" })).toThrow(
      ProfileCollectionError,
    );
  });
});
