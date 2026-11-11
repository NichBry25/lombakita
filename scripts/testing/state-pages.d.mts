/**
 * Types for state-pages.mjs, so TypeScript tests can read the gallery's state entries. The .mjs file
 * stays the implementation; this only describes its shape.
 */

type StatePage = {
  id: string;
  as: string | null;
  path: string;
  label: string;
  state?: string;
  interact?: unknown;
};

export declare const STATE_PAGES: readonly StatePage[];
