import { institutionTypeEnum, type InstitutionType } from "@/server/db/schema";

// Step 6.5f.1 — institution type taxonomy + the one-directional type-transition state machine.
//
// The taxonomy:
//   personal             — lightweight, single-member, capped institution a minimal-tier
//                          recruiter self-creates.
//   company | foundation | university | campus_organization
//                        — the four "full" subtypes, declared through the F10 verification flow
//                          (Step 6.5g). `community` is deferred post-Beta and is intentionally
//                          absent from the enum.
//   NULL (no value)      — a legacy full institution whose subtype was never declared. Every row
//                          created before this step backfills to NULL. NULL is treated as full.
//
// Predicate convention (mirrors the SQL):
//   "is personal"      → type === 'personal'
//   "is full/standard" → type !== 'personal' INCLUDING NULL (NULL IS DISTINCT FROM 'personal').
//
// This module is pure (no DB). The DB-backed services (createPersonalInstitutionForUser,
// upgradeInstitutionType) live in institution-service.ts and call assertInstitutionTypeTransition.

export const INSTITUTION_TYPES = institutionTypeEnum.enumValues;

export const PERSONAL_INSTITUTION_TYPE = "personal" as const satisfies InstitutionType;

// The four "full" subtypes. `personal` is excluded. `community` is deferred post-Beta.
export const FULL_INSTITUTION_TYPES = [
  "company",
  "foundation",
  "university",
  "campus_organization",
] as const satisfies readonly InstitutionType[];

export type FullInstitutionType = (typeof FULL_INSTITUTION_TYPES)[number];

// Reach caps for a personal institution. Enforced server-side at the existing gates
// (publish, competition-create, featured, invitation). Shared constants — never inline.
export const MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL = 2;
export const MAX_PERSONAL_INSTITUTIONS_PER_RECRUITER = 1;

export const isInstitutionType = (value: unknown): value is InstitutionType =>
  typeof value === "string" && (INSTITUTION_TYPES as readonly string[]).includes(value);

// A NULL type is NOT personal (it is a legacy full institution).
export const isPersonalInstitutionType = (type: InstitutionType | null): boolean =>
  type === PERSONAL_INSTITUTION_TYPE;

// A full/standard institution is anything that is not `personal` — including NULL.
export const isFullInstitution = (type: InstitutionType | null): boolean =>
  type !== PERSONAL_INSTITUTION_TYPE;

export const isFullInstitutionType = (value: unknown): value is FullInstitutionType =>
  typeof value === "string" && (FULL_INSTITUTION_TYPES as readonly string[]).includes(value);

export class InstitutionTypeTransitionError extends Error {
  constructor(
    public readonly code: "institution_type_transition_forbidden" = "institution_type_transition_forbidden",
    public readonly status: 409 = 409,
    message = "This institution type change is not permitted",
    public readonly details?: {
      currentType: InstitutionType | null;
      nextType: unknown;
    },
  ) {
    super(message);
    this.name = "InstitutionTypeTransitionError";
  }
}

// One-directional type-transition state machine. Exhaustive and fail-closed: any pair not
// explicitly permitted below throws.
//
//   NULL  → full subtype   : allowed   (legacy first-declaration; the F10 caller uses this in 6.5g)
//   personal → full subtype: allowed   (upgrade)
//   X → X (same → same)    : allowed   (no-op)
//   full subtype → other full subtype: forbidden
//   anything → personal    : forbidden (no downgrade, no personal-by-mutation)
//   unknown / unhandled    : forbidden (fail-closed)
//
// `current` may be null (an undeclared legacy full institution). `next` is typed as a concrete
// InstitutionType but is re-validated at runtime so a malformed value fails closed rather than
// slipping through.
export const assertInstitutionTypeTransition = (
  current: InstitutionType | null,
  next: InstitutionType,
): void => {
  const deny = (message: string): never => {
    throw new InstitutionTypeTransitionError(
      "institution_type_transition_forbidden",
      409,
      message,
      { currentType: current, nextType: next },
    );
  };

  // Fail closed on any value outside the known taxonomy on either side.
  if (!isInstitutionType(next)) {
    deny("Target institution type is not a recognized institution type");
  }
  if (current !== null && !isInstitutionType(current)) {
    deny("Current institution type is not a recognized institution type");
  }

  // Same → same: no-op (covers personal→personal and full→same-full).
  if (current === next) {
    return;
  }

  // Anything → personal is forbidden: no downgrade and no personal-by-mutation. (current === next
  // for personal is already handled above, so this only blocks non-personal/NULL → personal.)
  if (next === PERSONAL_INSTITUTION_TYPE) {
    deny("An institution cannot be converted to a personal institution");
  }

  // Legacy NULL → full subtype: first-declaration of an undeclared full institution.
  if (current === null) {
    return;
  }

  // personal → full subtype: the upgrade path.
  if (current === PERSONAL_INSTITUTION_TYPE) {
    return;
  }

  // Remaining reachable case: a full subtype → a different full subtype. Plus any pair this
  // function did not explicitly allow — fail closed.
  deny("A full institution cannot change to a different institution type");
};
