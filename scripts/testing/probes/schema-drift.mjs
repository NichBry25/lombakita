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
 * THE IDENTITY ASSERTION IS COVERED IN TWO HALVES, and the split is where the coverage is rather
 * than where it is missing. `verify-schema-drift.ts` and the `migration-database` connector probe
 * need a live server for the READ — the whole point is that the answer comes from the database rather
 * than from the string used to reach it — and that half was demonstrated against real databases: the
 * same staging credential is REFUSED when the checker is asked for production (naming
 * "lombakita_staging" against an expected "lombakita_production") and PASSES when asked for preview,
 * and the connector probe reports `live: down` with the same message. What the read RETURNS is now
 * read by one shared comparison, `identityMismatch` in `database-identity.ts`, and THAT is in-process
 * and mutable — so the role half of the assertion is probed below, and the flake is not the whole
 * story any more.
 *
 * Usage: node scripts/testing/probes/schema-drift.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const DRIFT = "src/server/db/schema-drift.ts";
const TEST = "src/server/db/schema-drift.test.ts";
const IDENTITY = "src/server/scripts/database-identity.ts";
const IDENTITY_TEST = "src/server/scripts/database-identity.test.ts";

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
  {
    name: "the role the server answers with is compared, not only the database",
    klass: "D",
    harmfulMove:
      "a lane that reached the RIGHT database as the WRONG role reporting the identity as matching " +
      "and going on to report on it — a credential that can do a different set of things there " +
      "than this lane assumes, which is the case DEC-0207 put the role beside the name for, and the " +
      "one the database-name comparison alone cannot see",
    files: [IDENTITY],
    // Flipped, for the reason the exception probe above gives: dropping the role half would leave
    // `expected.role` referenced only inside the guard that was removed, and the polarity flip
    // produces the harmful behaviour with every type intact — a wrong role waved through, and a
    // correct one refused.
    appliedMarkers: ["if (expected.role !== undefined && observed.role === expected.role) {"],
    mutate: () =>
      substituteOnce(
        IDENTITY,
        "if (expected.role !== undefined && observed.role !== expected.role) {",
        "if (expected.role !== undefined && observed.role === expected.role) {",
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", IDENTITY_TEST],
        /× .*names the role when only the role differs/,
      ),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("schema-drift", [
    ["npx", ["vitest", "run", TEST]],
    ["npx", ["vitest", "run", IDENTITY_TEST]],
  ]);
  await runProbes(probes);
}
