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
      institutionType: "university",
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

  it("rejects a user-provided slug that matches a reserved word with institution_slug_reserved", () => {
    const error = (() => {
      try {
        parseInstitutionWorkspaceCreateInput({
          displayName: "Admin Org",
          slug: "admin",
          institutionType: "company",
        });
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(InstitutionWorkspaceInputError);
    const cast = error as InstitutionWorkspaceInputError;
    expect(cast.code).toBe("institution_slug_reserved");
    expect(cast.httpStatus).toBe(422);
    expect(cast.details?.fields).toContain("slug");
  });

  it("rejects a displayName whose normalized form matches a reserved word", () => {
    for (const reservedName of ["Admin", "Settings", "api"]) {
      const error = (() => {
        try {
          parseInstitutionWorkspaceCreateInput({
            displayName: reservedName,
            institutionType: "company",
          });
          return null;
        } catch (e) {
          return e;
        }
      })();

      expect(error, `expected ${reservedName} to be rejected`).toBeInstanceOf(
        InstitutionWorkspaceInputError,
      );
      const cast = error as InstitutionWorkspaceInputError;
      expect(cast.code).toBe("institution_display_name_reserved");
      expect(cast.httpStatus).toBe(422);
      expect(cast.details?.fields).toContain("displayName");
    }
  });

  it("accepts a multi-word displayName whose tokens individually overlap reserved words", () => {
    const parsed = parseInstitutionWorkspaceCreateInput({
      displayName: "Admin University",
      institutionType: "company",
    });

    expect(parsed.displayName).toBe("Admin University");
    expect(parsed.slug).toBeNull();
  });

  it("requires a full institutionType at creation and returns it", () => {
    const parsed = parseInstitutionWorkspaceCreateInput({
      displayName: "Yayasan Harapan",
      institutionType: "foundation",
    });

    expect(parsed.institutionType).toBe("foundation");
  });

  it("rejects a missing institutionType", () => {
    const error = (() => {
      try {
        parseInstitutionWorkspaceCreateInput({ displayName: "Tanpa Tipe" });
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(InstitutionWorkspaceInputError);
    const cast = error as InstitutionWorkspaceInputError;
    expect(cast.code).toBe("institution_invalid_value");
    expect(cast.details?.fields).toContain("institutionType");
  });

  it("rejects `personal` as a create-time institutionType (personal has its own path)", () => {
    expect(() =>
      parseInstitutionWorkspaceCreateInput({
        displayName: "Bukan Personal",
        institutionType: "personal",
      }),
    ).toThrow(InstitutionWorkspaceInputError);
  });

  it("rejects an unrecognized institutionType", () => {
    expect(() =>
      parseInstitutionWorkspaceCreateInput({
        displayName: "Tipe Aneh",
        institutionType: "community",
      }),
    ).toThrow(InstitutionWorkspaceInputError);
  });

  it("substitutes the fallback base when auto-derivation lands on a reserved word", () => {
    const adminDerived = deriveInstitutionSlugBase("Admin");
    expect(adminDerived).not.toBe("admin");
    expect(adminDerived).toBe("institusi");

    const settingsDerived = deriveInstitutionSlugBase("Settings");
    expect(settingsDerived).not.toBe("settings");
    expect(settingsDerived).toBe("institusi");
  });

  it("rejects reserved-word slug in settings patch", () => {
    const error = (() => {
      try {
        parseInstitutionWorkspaceSettingsPatch({ slug: "api" });
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(InstitutionWorkspaceInputError);
    const cast = error as InstitutionWorkspaceInputError;
    expect(cast.code).toBe("institution_slug_reserved");
  });
});
