// Indonesian labels for an institution type, shared by every surface that names one: the settings
// shell's type pill, the public institution page, the admin verification queue, the institution
// verification shell and the institution-create form, which offers the kinds in this order.
//
// The record is keyed by `InstitutionType`, so adding a value to the institution_type pgEnum without
// giving it a label here is a compile error. `import type` is erased at compile time and never
// bundles the DB schema into a client build.
import type { InstitutionType } from "@/server/db/schema";

export const INSTITUTION_TYPE_LABELS: Record<InstitutionType, string> = {
  personal: "Pribadi",
  company: "Perusahaan",
  foundation: "Yayasan",
  university: "Universitas",
  campus_organization: "Organisasi kampus",
};
