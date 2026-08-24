/**
 * Types for declared-assertions.mjs, so the TypeScript test that pins the declaration can read it.
 * The .mjs file stays the single source of the LIST; this only describes its shape.
 */

export declare const R2_FLOWS_ASSERTIONS: readonly string[];

/** The declared ids no result speaks for, in declaration order. */
export declare const unreachedAssertions: (
  declared: readonly string[],
  results: { id: string }[],
) => string[];
