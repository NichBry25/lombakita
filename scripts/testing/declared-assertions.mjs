/*
 * WHAT A HARNESS SAYS IT ASSERTS, AND THE FUNCTION THAT HOLDS IT TO THAT.
 *
 * `r2-flows` nests seven of its assertions inside `if (target)` and `if (dPresign.status === 200)`.
 * A skipped assertion calls `record()` never, so it enters the results never, and the summary was
 * `passed / results.length` — both numbers shrinking together. A failure in DOC-03 dropped seven
 * assertions including the IDOR pin, and the run printed a green `15/15 passed`.
 *
 * That is the same defect as the `N/M pages clean` line the browser audits were rewritten to
 * remove: a total computed over what was measured, quoted as if it described what was meant to be
 * measured. THE DENOMINATOR IS THE DECLARED SITE COUNT, never the executed one, and an assertion
 * that did not run is a failure rather than an absence.
 *
 * The list below is the declaration. `declared-assertions.test.ts` pins it against the `record()`
 * calls that actually exist in the harness, resolved from the syntax tree rather than a grep, so a
 * new assertion cannot be added without appearing here and an entry cannot outlive its call site.
 */

export const R2_FLOWS_ASSERTIONS = [
  "R2-01",
  "R2-02",
  "R2-03",
  "R2-04",
  "R2-05",
  "R2-06",
  "R2-07",
  "R2-08",
  "R2-09",
  "R2-10",
  "R2-11",
  "R2-12",
  "DOC-01",
  "DOC-02",
  "DOC-03",
  "DOC-04",
  "DOC-05",
  "DOC-06",
  "DOC-07",
  "DOC-08",
  "DOC-09",
  "DOC-10",
];

/** The declared ids no result speaks for, in declaration order. */
export const unreachedAssertions = (declared, results) =>
  declared.filter((id) => !results.some((result) => result.id === id));
