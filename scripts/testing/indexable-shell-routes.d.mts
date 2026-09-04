/**
 * Types for indexable-shell-routes.mjs, so `src/config/indexable-routes.test.ts` can assert the
 * shell check's coverage against the indexable set. The .mjs file stays the single source of the
 * VALUES; this only describes their shape.
 */

/** One route the shell-content check fetches, and the body text it must find painted there. */
export type IndexableShellRoute = {
  path: string;
  needle: string;
  label: string;
};

export declare const INDEXABLE_SHELL_ROUTES: readonly IndexableShellRoute[];

/** Maps each indexable dynamic route family to the seeded URL the check measures it through. */
export declare const DYNAMIC_FAMILY_FIXTURES: Readonly<Record<string, string>>;
