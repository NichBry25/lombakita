// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DOCUMENT_TYPE_LABELS,
  REQUIRED_DOCUMENTS_BY_TYPE,
  deriveEmailDomainFlag,
  getMissingDocuments,
  getRequiredDocumentsForType,
  PERSONAL_EMAIL_DOMAINS,
  validateSubmissionDocuments,
} from "./verification-requirements";
import type { InstitutionType } from "@/server/db/schema";

describe("REQUIRED_DOCUMENTS_BY_TYPE — exhaustive coverage", () => {
  const ALL_TYPES: InstitutionType[] = [
    "personal",
    "company",
    "foundation",
    "university",
    "campus_organization",
  ];

  it("defines requirements for every institution type", () => {
    for (const t of ALL_TYPES) {
      expect(REQUIRED_DOCUMENTS_BY_TYPE[t]).toBeDefined();
    }
  });

  it("every full type requires at least one document; personal requires none", () => {
    for (const t of ALL_TYPES.filter((type) => type !== "personal")) {
      expect(REQUIRED_DOCUMENTS_BY_TYPE[t].length).toBeGreaterThan(0);
    }
    expect(REQUIRED_DOCUMENTS_BY_TYPE.personal).toEqual([]);
  });

  it("every required document type has a label", () => {
    for (const [, docs] of Object.entries(REQUIRED_DOCUMENTS_BY_TYPE)) {
      for (const doc of docs) {
        expect(DOCUMENT_TYPE_LABELS[doc]).toBeDefined();
      }
    }
  });

  it("personal requires no documents — a personal institution has no document verification", () => {
    expect(REQUIRED_DOCUMENTS_BY_TYPE.personal).toEqual([]);
  });

  it("company requires npwp and nib", () => {
    expect(REQUIRED_DOCUMENTS_BY_TYPE.company).toContain("npwp");
    expect(REQUIRED_DOCUMENTS_BY_TYPE.company).toContain("nib");
  });

  it("foundation requires npwp, akta_pendirian, sk_kemenkumham", () => {
    expect(REQUIRED_DOCUMENTS_BY_TYPE.foundation).toContain("npwp");
    expect(REQUIRED_DOCUMENTS_BY_TYPE.foundation).toContain("akta_pendirian");
    expect(REQUIRED_DOCUMENTS_BY_TYPE.foundation).toContain("sk_kemenkumham");
  });

  it("university requires sk_pendirian", () => {
    expect(REQUIRED_DOCUMENTS_BY_TYPE.university).toContain("sk_pendirian");
  });

  it("campus_organization requires surat_keterangan_organisasi and ktm", () => {
    expect(REQUIRED_DOCUMENTS_BY_TYPE.campus_organization).toContain("surat_keterangan_organisasi");
    expect(REQUIRED_DOCUMENTS_BY_TYPE.campus_organization).toContain("ktm");
  });
});

describe("getRequiredDocumentsForType", () => {
  it("returns the same array as REQUIRED_DOCUMENTS_BY_TYPE", () => {
    expect(getRequiredDocumentsForType("company")).toBe(REQUIRED_DOCUMENTS_BY_TYPE.company);
  });
});

describe("getMissingDocuments", () => {
  it("returns empty array when all required docs are present", () => {
    expect(getMissingDocuments("personal", [])).toEqual([]);
    expect(getMissingDocuments("company", ["npwp", "nib"])).toEqual([]);
  });

  it("returns missing doc types when some are absent", () => {
    const missing = getMissingDocuments("company", ["npwp"]);
    expect(missing).toContain("nib");
    expect(missing).not.toContain("npwp");
  });

  it("returns all required docs when nothing is submitted", () => {
    const required = getRequiredDocumentsForType("foundation");
    const missing = getMissingDocuments("foundation", []);
    expect(missing).toEqual([...required]);
  });

  it("extra submitted docs do not produce false positives", () => {
    const missing = getMissingDocuments("company", ["npwp", "nib", "extra_doc"]);
    expect(missing).toEqual([]);
  });
});

describe("validateSubmissionDocuments", () => {
  it("returns true when all required docs are present", () => {
    expect(validateSubmissionDocuments("personal", [])).toBe(true);
    expect(validateSubmissionDocuments("company", ["npwp", "nib"])).toBe(true);
  });

  it("returns false when any required doc is missing", () => {
    expect(validateSubmissionDocuments("company", ["npwp"])).toBe(false);
    expect(validateSubmissionDocuments("foundation", ["npwp"])).toBe(false);
  });
});

describe("deriveEmailDomainFlag", () => {
  it("returns null for institution types that are not university or campus_organization", () => {
    expect(deriveEmailDomainFlag("personal", "user@gmail.com")).toBeNull();
    expect(deriveEmailDomainFlag("company", "user@company.co.id")).toBeNull();
    expect(deriveEmailDomainFlag("foundation", "user@gmail.com")).toBeNull();
  });

  it("returns false for known personal-provider domains", () => {
    for (const domain of ["gmail.com", "yahoo.com", "yahoo.co.id", "outlook.com", "hotmail.com"]) {
      expect(deriveEmailDomainFlag("university", `user@${domain}`)).toBe(false);
      expect(deriveEmailDomainFlag("campus_organization", `user@${domain}`)).toBe(false);
    }
  });

  it("returns true for institutional domains", () => {
    expect(deriveEmailDomainFlag("university", "dosen@ui.ac.id")).toBe(true);
    expect(deriveEmailDomainFlag("campus_organization", "mahasiswa@its.ac.id")).toBe(true);
  });

  it("is case-insensitive on domain part", () => {
    expect(deriveEmailDomainFlag("university", "user@GMAIL.COM")).toBe(false);
    expect(deriveEmailDomainFlag("university", "user@UI.AC.ID")).toBe(true);
  });

  it("returns null when email has no @ or malformed domain", () => {
    expect(deriveEmailDomainFlag("university", "notanemail")).toBeNull();
    expect(deriveEmailDomainFlag("university", "@")).toBeNull();
  });

  it("covers all entries in PERSONAL_EMAIL_DOMAINS", () => {
    for (const domain of PERSONAL_EMAIL_DOMAINS) {
      expect(deriveEmailDomainFlag("university", `test@${domain}`)).toBe(false);
    }
  });
});
