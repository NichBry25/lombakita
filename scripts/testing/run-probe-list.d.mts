/**
 * Types for run-probe-list.mjs, so the TypeScript test can read a probe list and the harness probes
 * built from it without running them. The .mjs file stays the single source of the BEHAVIOUR.
 */
import type { GuardClass, Probe } from "./guard-probe.mjs";

export interface ProbeEdit {
  file: string;
  find: string;
  replace: string;
}

export interface ProbeDetector {
  command: string;
  args: string[];
  reached?: string;
}

export interface ProbeSpec {
  name: string;
  klass: GuardClass;
  harmfulMove: string;
  files: string[];
  repo?: string;
  edits: ProbeEdit[];
  appliedMarkers: string[];
  detector: ProbeDetector;
}

export interface ProbeList {
  probes: ProbeSpec[];
}

export declare const GUARD_CLASSES: GuardClass[];
export declare class ProbeListRefusal extends Error {}
export declare const readProbeList: (path: string) => ProbeList;
export declare const buildHarnessProbes: (list: ProbeList) => Probe[];
