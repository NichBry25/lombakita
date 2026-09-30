// MANUAL-D50: one home per institution enum, so a surface cannot render the raw token.
//
// Each of these maps is typed `Record<TheEnum, string>`, which is the real exhaustiveness check: a
// value added to the pgEnum without a label here is a TypeScript error in this project's own
// `npm run typecheck`, not a blank cell discovered by a reader. The runtime assertions below cover
// what the type cannot — the words themselves, and that nothing was left empty.

import { describe, expect, it } from "vitest";

import { INSTITUTION_STATUS_LABELS } from "./status-labels";
import { FULL_INSTITUTION_TYPE_LABELS, INSTITUTION_TYPE_LABELS } from "./type-labels";
import { INSTITUTION_VERIFICATION_STATUS_LABELS } from "./verification-status-labels";

describe("INSTITUTION_TYPE_LABELS", () => {
  it("names every institution type in Indonesian", () => {
    expect(INSTITUTION_TYPE_LABELS).toEqual({
      personal: "Pribadi",
      company: "Perusahaan",
      foundation: "Yayasan",
      university: "Universitas",
      campus_organization: "Organisasi kampus",
    });
  });

  it("offers the full types in the order the forms present them, without `personal`", () => {
    // `personal` is what these forms upgrade FROM, so offering it would let a form create the state
    // it exists to leave.
    expect(Object.keys(FULL_INSTITUTION_TYPE_LABELS)).toEqual([
      "company",
      "foundation",
      "university",
      "campus_organization",
    ]);
  });

  it("spells the full types with the same words as the shared map", () => {
    // The two maps exist so a form cannot offer `personal`; if they ever disagree, the same
    // institution is named two ways depending on which surface drew it.
    for (const [type, label] of Object.entries(FULL_INSTITUTION_TYPE_LABELS)) {
      expect(label, type).toBe(
        INSTITUTION_TYPE_LABELS[type as keyof typeof INSTITUTION_TYPE_LABELS],
      );
    }
  });

  it("leaves no label empty, so nothing renders as a blank cell", () => {
    for (const [key, label] of Object.entries(INSTITUTION_TYPE_LABELS)) {
      expect(label.trim(), key).not.toBe("");
    }
  });
});

describe("INSTITUTION_STATUS_LABELS", () => {
  it("names every platform status in Indonesian", () => {
    expect(INSTITUTION_STATUS_LABELS).toEqual({
      active: "Aktif",
      inactive: "Nonaktif",
      suspended: "Ditangguhkan",
    });
  });

  it("leaves no label empty, so nothing renders as a blank cell", () => {
    for (const [key, label] of Object.entries(INSTITUTION_STATUS_LABELS)) {
      expect(label.trim(), key).not.toBe("");
    }
  });
});

describe("INSTITUTION_VERIFICATION_STATUS_LABELS", () => {
  it("names every verification state in Indonesian", () => {
    expect(INSTITUTION_VERIFICATION_STATUS_LABELS).toEqual({
      pending_verification: "Menunggu Verifikasi",
      under_review: "Sedang Ditinjau",
      verified: "Terverifikasi Admin",
      rejected: "Ditolak Admin",
    });
  });

  it("leaves no label empty, so nothing renders as a blank cell", () => {
    for (const [key, label] of Object.entries(INSTITUTION_VERIFICATION_STATUS_LABELS)) {
      expect(label.trim(), key).not.toBe("");
    }
  });
});
