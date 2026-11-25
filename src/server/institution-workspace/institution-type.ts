import { institutionTypeEnum, type InstitutionType } from "@/server/db/schema";

// Institution type taxonomy. A host picks the kind on the one create form, and it is fixed at
// creation. `community` is deferred post-Beta and is intentionally absent from the enum. This module
// is pure (no DB).

export const INSTITUTION_TYPES = institutionTypeEnum.enumValues;

export const PERSONAL_INSTITUTION_TYPE = "personal" as const satisfies InstitutionType;

// Reach caps for a personal institution. Enforced server-side at the existing gates
// (publish, competition-create, featured, invitation). Shared constants — never inline.
//
// The published-competitions cap is declared in `lib/institutions/reach-caps.ts` and re-exported
// here so its server callers keep one import path. It moved because this module imports the Drizzle
// schema, and the publish control has to name the cap in an Indonesian sentence on the client —
// see that file's header. Still one definition, read from two directions.
export { MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL } from "@/lib/institutions/reach-caps";

export const isInstitutionType = (value: unknown): value is InstitutionType =>
  typeof value === "string" && (INSTITUTION_TYPES as readonly string[]).includes(value);

// A NULL type is NOT personal (it is a legacy full institution).
export const isPersonalInstitutionType = (type: InstitutionType | null): boolean =>
  type === PERSONAL_INSTITUTION_TYPE;
