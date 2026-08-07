/**
 * Types for seeds.mjs, so TypeScript scripts elsewhere under scripts/ can consume the shared seed
 * fixture. The .mjs file stays the single source of the VALUES; this only describes their shape.
 */

export declare const BASE: string;
export declare const PASSWORD: string;
export declare const MFA_FACTOR_SECRET_HEX: string;

/** Which of the three operational MFA states an account is seeded into; absent for self-service. */
export type SeedMfaState = "enrolment" | "challenge" | "satisfied";

export type SeedUserKey =
  | "candA"
  | "candB"
  | "candC"
  | "recMin"
  | "recElev"
  | "recRej"
  | "recDraft"
  | "dual"
  | "ops"
  | "opsEnrol"
  | "opsChal"
  | "susp"
  | "unver";

export declare const USERS: Record<
  SeedUserKey,
  { id: string; email: string; username: string; mfa?: SeedMfaState }
>;
export declare const INST: Record<string, { id: string; slug: string }>;
export declare const COMP: Record<string, { id: string; slug: string }>;
export declare const REG: Record<string, { id: string }>;
