import { institutionTypeEnum, type InstitutionType } from "@/server/db/schema";

// Institution type taxonomy. A host picks the kind on the one create form, and it is fixed at
// creation. `community` is deferred post-Beta and is intentionally absent from the enum. This module
// is pure (no DB).

export const INSTITUTION_TYPES = institutionTypeEnum.enumValues;

export const PERSONAL_INSTITUTION_TYPE = "personal" as const satisfies InstitutionType;

export const isInstitutionType = (value: unknown): value is InstitutionType =>
  typeof value === "string" && (INSTITUTION_TYPES as readonly string[]).includes(value);

// A NULL type is NOT personal (it is a legacy full institution).
export const isPersonalInstitutionType = (type: InstitutionType | null): boolean =>
  type === PERSONAL_INSTITUTION_TYPE;
