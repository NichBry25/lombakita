/**
 * Types for seeds.mjs, so TypeScript scripts elsewhere under scripts/ can consume the shared seed
 * fixture. The .mjs file stays the single source of the VALUES; this only describes their shape.
 */

export declare const BASE: string;
export declare const PASSWORD: string;

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
  | "susp"
  | "unver";

export declare const USERS: Record<SeedUserKey, { id: string; email: string; username: string }>;
export declare const INST: Record<string, { id: string; slug: string }>;
export declare const COMP: Record<string, { id: string; slug: string }>;
export declare const REG: Record<string, { id: string }>;
