// Indonesian labels for an institution type, shared by every surface that names one: the settings
// shell's read-only pill, the public institution page, the admin verification queue, the institution
// verification shell, the personal→full upgrade form and the institution-create form.
//
// The record is keyed by `InstitutionType`, so adding a value to the institution_type pgEnum without
// giving it a label here is a compile error. `import type` is erased at compile time and never
// bundles the DB schema into a client build.
import type { FullInstitutionType } from "@/server/institution-workspace/institution-type";
import type { InstitutionType } from "@/server/db/schema";

export const INSTITUTION_TYPE_LABELS: Record<InstitutionType, string> = {
  personal: "Pribadi",
  company: "Perusahaan",
  foundation: "Yayasan",
  university: "Universitas",
  campus_organization: "Organisasi kampus",
};

// The types the personal→full upgrade and the full-create form offer, in selection order. `personal`
// is not among them: it is created by its own path and is what these forms upgrade FROM, so offering
// it here would let a form create the state it exists to leave.
export const FULL_INSTITUTION_TYPE_LABELS: Record<FullInstitutionType, string> = {
  company: INSTITUTION_TYPE_LABELS.company,
  foundation: INSTITUTION_TYPE_LABELS.foundation,
  university: INSTITUTION_TYPE_LABELS.university,
  campus_organization: INSTITUTION_TYPE_LABELS.campus_organization,
};
