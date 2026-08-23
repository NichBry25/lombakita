/**
 * Types for finding-classes.mjs, so the TypeScript test that pins the declaration can read it. The
 * .mjs file stays the single source of the TABLE; this only describes its shape.
 */

export interface FindingClass {
  audit: "mobile-audit" | "contrast-audit";
  describes: string;
  unit: string;
  /** "raw" when the measurement is already higher-is-worse; "deficit" when the shortfall is stored. */
  metric: "raw" | "deficit";
  magnitudeOf: (measurement: Record<string, number>) => number;
  example: { measurement: Record<string, number>; magnitude: number };
}

export declare const FINDING_CLASSES: Record<string, FindingClass>;

export declare const finding: (
  className: string,
  key: string,
  measurement: Record<string, number>,
  detail?: Record<string, unknown>,
) => { key: string; class: string; magnitude: number } & Record<string, unknown>;
