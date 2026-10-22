/**
 * The judge of a mutation of the protect script. The mutations themselves are a private corpus that
 * is loaded from the docs repository at run time (protect-corpus.ts); what a mutation is and how a
 * run of it is judged is all this file holds.
 */

import type { ProtectMismatch, ProtectRow } from "./protect-table";

export interface ProtectMutation {
  element: string;
  pattern: RegExp;
  replacement: string;
  /** The rows whose answer the edit changes. The run must flip exactly these and no others. */
  flips: (row: ProtectRow) => boolean;
  /** The columns in which a flipped row may differ; the default is every column. */
  reasons?: readonly string[];
  /** The mutation is about the crash handling, so a flipped row may carry the crash text. */
  crash?: true;
  /** The platforms the element can be proved on; the default is every platform. */
  platforms?: readonly NodeJS.Platform[];
}

export const CRASH_TEXT = "the hook failed";

export interface MutationVerdict {
  declared: string[];
  flipped: string[];
  missing: string[];
  extra: string[];
  crashed: string[];
  outsideReasons: string[];
}

export const appliesHere = (mutation: ProtectMutation): boolean =>
  mutation.platforms === undefined || mutation.platforms.includes(process.platform);

/** Compares the rows the mutated script answered differently with the rows the mutation declares. */
export const judgeMutation = (
  mutation: ProtectMutation,
  table: readonly ProtectRow[],
  mismatches: readonly ProtectMismatch[],
): MutationVerdict => {
  const declared = table.filter(mutation.flips).map((row) => row.id);
  const flipped = mismatches.map((mismatch) => mismatch.id);
  const crashed =
    mutation.crash === true
      ? []
      : mismatches.filter((mismatch) => mismatch.stderr.includes(CRASH_TEXT)).map((m) => m.id);
  const allowedReasons = mutation.reasons;
  const outsideReasons =
    allowedReasons === undefined
      ? []
      : [...new Set(mismatches.flatMap((mismatch) => mismatch.reasons))].filter(
          (reason) => !allowedReasons.includes(reason),
        );
  return {
    declared,
    flipped,
    missing: declared.filter((id) => !flipped.includes(id)),
    extra: flipped.filter((id) => !declared.includes(id)),
    crashed,
    outsideReasons,
  };
};

/** What stops a proof from counting: an edit that did not apply or compile, or a run that differs from the declaration. */
export const mutationProblems = (
  result: { applied: boolean; compiles: boolean },
  verdict: MutationVerdict,
): string[] => {
  const problems: string[] = [];
  if (!result.applied) problems.push("the edit did not change the script");
  if (!result.compiles)
    problems.push("the edited script does not compile (bash -n or its python body)");
  if (verdict.missing.length > 0)
    problems.push(`declared rows that did not flip: ${JSON.stringify(verdict.missing)}`);
  if (verdict.extra.length > 0)
    problems.push(`rows that flipped without being declared: ${JSON.stringify(verdict.extra)}`);
  if (verdict.crashed.length > 0)
    problems.push(`rows that crashed the script: ${JSON.stringify(verdict.crashed)}`);
  if (verdict.outsideReasons.length > 0)
    problems.push(`columns outside the declared ones: ${JSON.stringify(verdict.outsideReasons)}`);
  return problems;
};
