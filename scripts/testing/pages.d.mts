/**
 * Types for pages.mjs, so TypeScript tests can read the gallery's page inventory. The .mjs file stays
 * the implementation; this only describes its shape.
 */

type Page = {
  id: string;
  as: string | null;
  path: string;
  label: string;
};

export declare const PAGES: readonly Page[];
