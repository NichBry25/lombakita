/**
 * Types for guard-probe.mjs, so the TypeScript test that pins the probe harness's declared subject
 * can read it. The .mjs file stays the single source of the BEHAVIOUR.
 */

/** Rule 36's guard classes. The detector a probe may use follows from which one it is. */
export type GuardClass = "A1-in" | "A1-pre" | "A2" | "B" | "C" | "D";

export interface Probe {
  name: string;
  klass: GuardClass;
  harmfulMove: string;
  files: string[];
  appliedMarkers: string[];
  mutate: () => void | Promise<void>;
  compiles?: () => void | Promise<void>;
  detect: () => Promise<{ refused: boolean; evidence: string }>;
}

export declare const CODE_CHECKS: Record<string, (file: string) => unknown>;
export declare const DATA_CHECKS: Record<string, (file: string) => unknown>;
export declare const extensionOf: (file: string) => string;
export declare const isCodeFile: (file: string) => boolean;
export declare const compileCheckFor: (file: string) => () => unknown;
export declare const substituteOnce: (path: string, find: string, replace: string) => void;
export declare const pathsClean: (files: string[]) => boolean;
export declare const runProbe: (
  spec: Probe,
) => Promise<{ name: string; ok: boolean; detail: string }>;
export declare const runProbes: (probes: Probe[]) => Promise<void>;
