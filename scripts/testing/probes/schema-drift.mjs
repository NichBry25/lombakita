/*
 * Rule 36 probes for the deploy gate's schema-drift comparison.
 *
 * `deploy.yml` ran no drift check and said so, so a checkout whose migrations the database had
 * never applied deployed clean and the two only disagreed later, in whichever request first touched
 * the missing column.
 *
 * CLASS D — the comparison is a pure function read for its RESULT CONTENT: which rows diverge. A
 * pure read has no move analogue, so there is no ordering probe here and none is being withheld.
 *
 * WHAT THESE PROBES DO NOT COVER, stated rather than implied. The `current_database()` assertion
 * (DEC-0207) lives in `verify-schema-drift.ts` and in the `migration-database` connector probe, and
 * both need a live server to mean anything — the whole point is that the answer comes from the
 * database rather than from the string used to reach it, so there is nothing to mutate in-process
 * that would prove it. It was demonstrated against real databases instead: the same staging
 * credential is REFUSED when the checker is asked for production (naming "lombakita_staging" against
 * an expected "lombakita_production") and PASSES when asked for preview, and the connector probe
 * reports `live: down` with the same message. Those runs are the evidence for that half; these
 * probes are the evidence for the comparison half.
 *
 * Usage: node scripts/testing/probes/schema-drift.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const DRIFT = "src/server/db/schema-drift.ts";
const TEST = "src/server/db/schema-drift.test.ts";

export const probes = [
  {
    name: "a file edited after it was applied is caught",
    klass: "D",
    harmfulMove:
      "the per-row hash comparison not comparing, leaving the check with the count-and-endpoints " +
      "property it was built to replace — which passes for a history whose middle rows belong to " +
      "a different checkout",
    files: [DRIFT],
    // Compares the declared hash with itself: always false at run time, but not STATICALLY false,
    // so the branch stays reachable and the narrowing inside it still type-checks. `&& false` does
    // not work here — it makes the block dead code and TypeScript stops narrowing `exception`.
    appliedMarkers: ["if (declared.hash !== declared.hash)"],
    mutate: () =>
      substituteOnce(
        DRIFT,
        "if (declared.hash !== found.hash) {",
        "if (declared.hash !== declared.hash) {",
      ),
    detect: async () =>
      fails("npx", ["vitest", "run", TEST], /× .*catches a file edited after it was applied/),
  },
  {
    name: "an accepted divergence is pinned to two hashes, not skipped",
    klass: "D",
    harmfulMove:
      "treating a declared exception as a hole: the two migrations most likely to be edited " +
      "again become permanently unwatchable, and any third hash in those positions passes",
    files: [DRIFT],
    // Inverted rather than dropped. Dropping the hash half (`if (exception)`) narrows `exception`
    // to `never` below and stops the file compiling, so it never reaches the assertion. Inverting
    // keeps every type the same and produces the harmful behaviour exactly: the pinned hash is
    // reported as drift, and a third, unknown hash is waved through.
    appliedMarkers: ["found.hash !== exception.legacyHash"],
    mutate: () =>
      substituteOnce(
        DRIFT,
        "if (exception && found.hash === exception.legacyHash) {",
        "if (exception && found.hash !== exception.legacyHash) {",
      ),
    detect: async () => fails("npx", ["vitest", "run", TEST], /× .*STILL FAILS on a third hash/),
  },
  {
    name: "a database behind the checkout is caught",
    klass: "D",
    harmfulMove:
      "declared-but-unapplied migrations going unreported, which is the original defect: the " +
      "deployment ships code whose schema the database does not have",
    files: [DRIFT],
    appliedMarkers: ["for (let index = shared; index < shared;"],
    mutate: () =>
      substituteOnce(
        DRIFT,
        "for (let index = shared; index < journal.length; index += 1) {",
        "for (let index = shared; index < shared; index += 1) {",
      ),
    detect: async () =>
      fails("npx", ["vitest", "run", TEST], /× .*catches a database that is behind the checkout/),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  await runProbes(probes);
}
