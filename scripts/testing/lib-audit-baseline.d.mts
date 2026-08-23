/**
 * Types for lib-audit-baseline.mjs, so TypeScript tests under scripts/ can exercise the baseline
 * comparison. The .mjs file stays the single source of the BEHAVIOUR; this only describes its shape.
 */

/** One measured fault. `magnitude` is how bad it is in the audit's own unit, higher is worse. */
export interface AuditFinding {
  key: string;
  magnitude?: number;
  [detail: string]: unknown;
}

export interface Baseline {
  takenAt: string | null;
  keys: Set<string>;
  byKey: Map<string, AuditFinding>;
}

export interface BaselineComparison {
  fresh: AuditFinding[];
  worsened: { key: string; was: number; now: number }[];
  healed: string[];
}

export declare const CURATED_DROP_FLAG: string;
export declare const EXIT_FINDINGS: number;
export declare const EXIT_UNMEASURABLE: number;
export declare const baselinePath: (name: string) => string;
export declare const readBaseline: (name: string) => Baseline;
export declare const writeBaseline: (
  name: string,
  findings: AuditFinding[],
  note: string,
) => void;
export declare const classifyAgainstBaseline: (
  findings: AuditFinding[],
  baseline: Baseline,
) => BaselineComparison;
