/**
 * THE FILES THE ASSERTION-STRENGTH GATE READS.
 *
 * This list is the gate's declared subject, and the test beside it pins that the declaration equals
 * the actual population: every file under scripts/testing that declares a `record(...)` of the
 * shared shape must appear here, or the build fails.
 *
 * It is a list rather than a constant because it was a constant. The gate read `api-matrix.mjs` and
 * nothing else, while `r2-flows.mjs` declared its own `record` with a byte-identical signature and
 * carried eleven assertions that were weak by the gate's own definition — including a cross-tenant
 * check that passed on whichever status the code answered. The gate reported green throughout. A
 * gate whose subject is one hardcoded path covers exactly as much as whoever last remembered it.
 */
export const ASSERTION_HARNESSES = [
  "scripts/testing/api-matrix.mjs",
  "scripts/testing/r2-flows.mjs",
] as const;
