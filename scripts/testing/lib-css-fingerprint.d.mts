/**
 * Types for lib-css-fingerprint.mjs, so TypeScript tests under scripts/ can exercise the selector and
 * token parsing. The .mjs file stays the single source of the BEHAVIOUR; this only describes its shape.
 */

export interface StylesheetSource {
  path: string;
  text: string;
}

export interface SourceTokensByTheme {
  light: Map<string, string>;
  dark: Map<string, string>;
}

export declare const BROWSER_DROPPED_PSEUDO_PREFIXES: string[];
export declare const canonicalSelector: (selector: string) => string;
export declare const sourceTokens: (sources: StylesheetSource[]) => SourceTokensByTheme;
export declare const readStylesheetSources: () => StylesheetSource[];
