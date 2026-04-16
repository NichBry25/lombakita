import { describe, expect, it } from "vitest";
import {
  InstitutionWorkspaceInputError,
  buildInstitutionSlugCandidate,
  deriveInstitutionSlugBase,
  normalizeInstitutionSlug,
  parseInstitutionWorkspaceCreateInput,
  parseInstitutionWorkspaceSettingsPatch,
} from "@/server/institution-workspace/institution-core";

describe("institution-core", () => {
  it("normalizes explicit slug input during institution creation parsing", () => {
    const parsed = parseInstitutionWorkspaceCreateInput({
      displayName: "Universitas Bina Sarana",
      slug: "  BINUS  Jakarta!!  ",
    });

    expect(parsed.slug).toBe("binus-jakarta");
  });

  it("derives deterministic slug base from institution display name", () => {
    const derived = deriveInstitutionSlugBase("Universitas Teknologi Ásia 2026");

    expect(derived).toBe("universitas-teknologi-asia-2026");
  });

  it("builds uniqueness-safe slug candidates with numeric suffixes", () => {
    expect(buildInstitutionSlugCandidate("universitas-nusantara", 0)).toBe("universitas-nusantara");
    expect(buildInstitutionSlugCandidate("universitas-nusantara", 1)).toBe(
      "universitas-nusantara-2",
    );
    expect(buildInstitutionSlugCandidate("universitas-nusantara", 4)).toBe(
      "universitas-nusantara-5",
    );
  });

  it("normalizes route slug lookups to lowercase kebab form", () => {
    expect(normalizeInstitutionSlug(" Institut Teknologi-ABC ")).toBe("institut-teknologi-abc");
  });

  it("rejects protected institution settings fields", () => {
    expect(() =>
      parseInstitutionWorkspaceSettingsPatch({
        status: "active",
      }),
    ).toThrow(InstitutionWorkspaceInputError);
  });
});
