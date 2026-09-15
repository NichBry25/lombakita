/**
 * Types for detectors.mjs, so the TypeScript test that pins how a probe reads a verdict can call it.
 * The .mjs file stays the single source of the BEHAVIOUR.
 */
import type { SpawnSyncReturns } from "node:child_process";

/** What `run` hands back: both streams captured, and the exit status the verdict is read against. */
export type RunResult = SpawnSyncReturns<string>;

export declare const run: (
  command: string,
  args: string[],
  env?: Record<string, string>,
) => RunResult;

export interface RefusalSpec {
  status?: number;
  reached?: RegExp;
  forbidden?: RegExp;
  label: string;
  retry?: () => RunResult;
}

export declare const refusedWhen: (
  result: RunResult,
  spec: RefusalSpec,
) => { refused: boolean; evidence: string };

export declare const TEST_FAILURE: RegExp;

export declare const fails: (
  command: string,
  args: string[],
  reached?: RegExp,
) => { refused: boolean; evidence: string };
