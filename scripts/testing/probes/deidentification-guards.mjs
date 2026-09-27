/*
 * Rule 36 probes for the account de-identification action.
 *
 * WHAT THIS ACTION IS THE ONLY THING STANDING IN FRONT OF. `deidentifyAccount` is the platform's one
 * in-app path for removing a person on their own request, and it is irreversible by construction: the
 * files go, the personal rows go, and the rows other people depend on are kept with the personal
 * values stripped out. There is no second attempt after it has run, because there is nothing left to
 * run it against.
 *
 * EVERY MUTATION HERE LANDS IN `account-deidentification-service.ts`, and the detectors are the two
 * suites that already cover it — the unit test for the prefix list, the integration suite for the
 * refusals and the full run, the committing race suite for the row lock. Nothing in this file is a
 * new test written for the probe's benefit; a probe whose detector exists only to be broken by it
 * measures the probe.
 *
 * THE CLASS OF EACH GUARD IS DECLARED RATHER THAN ASSUMED (clause 8). Four of the five are B: a
 * refusal, or a lock, that stands in front of a write and takes no transaction of its own. The
 * rehearsal sentinel is A1-in: it throws INSIDE the transaction and the rollback is what restores the
 * post-state, so its detector is the refusal identity — the run that follows a committed rehearsal
 * refuses instead of de-identifying. The one class D probe is the prefix list, whose guard is the
 * CONTENT of a returned array.
 *
 * WHAT IS NOT PROBED, AND WHY. The compare-and-set (`where id = U and status <> 'deactivated'`) is
 * not separately probed. Every interleaving that reaches it has already been refused by the
 * deactivated clause re-run inside the writing transaction — that clause throws first, from the same
 * locked row — so removing the CAS predicate turns no assertion red, and a probe reporting otherwise
 * would be reporting a property the code does not have. It is recorded here rather than fabricated
 * into a green.
 *
 * Usage: node scripts/testing/probes/deidentification-guards.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const SERVICE = "src/server/accounts/account-deidentification-service.ts";
const UNIT_TEST = "src/server/accounts/account-deidentification-service.test.ts";
const INTEGRATION_TEST = "src/server/accounts/account-deidentification-db.integration.test.ts";
const RACE_TEST = "src/server/accounts/account-deidentification-race-db.integration.test.ts";

export const probes = [
  {
    name: "the writing transaction locks the target's row before the checks it protects",
    klass: "B",
    harmfulMove:
      "two de-identifications of the same account running their reads and writes interleaved because " +
      "the writing transaction never takes the row, so a second operator's run is told the account is " +
      "eligible on the strength of a read that the first run invalidates before the second one writes",
    files: [SERVICE],
    // The lock's EFFECT removed rather than its clause rewritten: the `for update` suffix is dropped
    // and the statement stays a statement, so the mutation compiles for a reason rather than by luck
    // (clause 1). The marker carries the blank line and the comment that follow, because the
    // statement WITHOUT the suffix is a prefix of the statement with it and would be present before
    // the mutation as well.
    appliedMarkers: [
      "  await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId));\n\n  // The pre-read",
    ],
    mutate: () =>
      substituteOnce(
        SERVICE,
        '  await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId)).for("update");',
        "  await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId));",
      ),
    // THE DETECTOR HAD TO BE BUILT BEFORE THIS PROBE COULD BE HONEST. The race suite already polled
    // `pg_blocking_pids` for both racers, and that poll stays green with the lock removed — the
    // compare-and-set writes the same row a few statements later, so the racers simply queue there
    // instead. That was measured, not reasoned about. The assertion this detector names reads the
    // parked backend's own statement from `pg_stat_activity`, which is what tells a racer queued at
    // the lock from one queued at the write the lock exists to precede.
    detect: async () =>
      fails("npx", ["vitest", "run", RACE_TEST], /rather than on the target's row lock/),
  },
  {
    name: "a deactivated target with objects still in the bucket is finished, not refused",
    klass: "B",
    harmfulMove:
      "the deactivated clause read the wrong way round, so an interrupted run — one that reached " +
      "storage and died before its commit, or committed and died before deleting — is refused as " +
      "already done and the files it left under the target's prefixes are never removed",
    files: [SERVICE],
    appliedMarkers: ["      (await anyObjectRemainsUnder("],
    // The negation is the whole of the clause, so removing it is the whole of the harm. The marker
    // carries the six leading spaces: bare `(await anyObjectRemainsUnder(` IS a substring of the
    // un-negated call's `!(await ...`, and a marker that survives the mutation proves nothing.
    mutate: () =>
      substituteOnce(
        SERVICE,
        "      !(await anyObjectRemainsUnder(",
        "      (await anyObjectRemainsUnder(",
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", INTEGRATION_TEST],
        /× .*refuses 409 already-done for an account that is deactivated with no objects left/,
      ),
  },
  {
    name: "the deletion set never reaches the payment-proofs prefix",
    klass: "D",
    harmfulMove:
      "the prefix list widened to the ledger's own evidence, so a de-identification would delete the " +
      "image behind a row DEC-0133 forbids removing and leave an append-only row pointing at nothing " +
      "— a harm the action cannot undo, since the object is gone and the row stays",
    files: [SERVICE],
    // The prefix is pushed as a literal rather than through `fillUserPrefix`, because the real
    // template has no `{userId}` placeholder and the substitution helper would throw on it — a red
    // for a reason this probe did not claim (clause 1).
    appliedMarkers: ["  prefixes.push(`payment-proofs/${target.userId}/`);"],
    mutate: () =>
      substituteOnce(
        SERVICE,
        "  if (target.personalInstitutionId !== null) {",
        "  prefixes.push(`payment-proofs/${target.userId}/`);\n\n  if (target.personalInstitutionId !== null) {",
      ),
    detect: async () =>
      fails("npx", ["vitest", "run", UNIT_TEST], /× .*never lists payment-proofs, on any target/),
  },
  {
    name: "the typed confirmation is compared exactly, casing included",
    klass: "B",
    harmfulMove:
      "a near-match accepted as the confirmation, so an operator who typed a different account's " +
      "username — or the right name with a stray capital — de-identifies a person they never named",
    files: [SERVICE],
    appliedMarkers: [
      "  if (input.confirmUsername.trim().toLowerCase() !== target.username.trim().toLowerCase()) {",
    ],
    // Normalised rather than deleted, and deliberately: an empty comparison would be a shape no
    // reviewer would write, while trimming and lowercasing is exactly the correction someone makes
    // when a confirmation "keeps failing". Every type and every reference stays in place.
    mutate: () =>
      substituteOnce(
        SERVICE,
        "  if (input.confirmUsername !== target.username) {",
        "  if (input.confirmUsername.trim().toLowerCase() !== target.username.trim().toLowerCase()) {",
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", INTEGRATION_TEST],
        /× .*refuses 400 when the typed confirmation differs, casing included/,
      ),
  },
  {
    name: "the rehearsal rolls back rather than committing what it rehearsed",
    klass: "A1-in",
    harmfulMove:
      "the rehearsal committing its own writes: the pre-flight pass that exists to prove the writes " +
      "would succeed would itself de-identify the account, and the real run that follows it would " +
      "find the account already deactivated and refuse — an operator told the action failed, holding " +
      "an account that is gone",
    files: [SERVICE],
    // The throw replaced by a use of the same variable, so `written` stays read, `rollbackThrown`
    // stays assigned, and the transaction returns normally — the commit this guard exists to prevent,
    // reached with every reference intact. Removing `rollbackThrown = true` instead would leave the
    // tripwire below it to throw, which is a red for a reason this probe did not claim (clause 1).
    appliedMarkers: ["        void written;"],
    mutate: () =>
      substituteOnce(
        SERVICE,
        "        throw new RehearsalRollback(written);",
        "        void written;",
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", INTEGRATION_TEST],
        /× .*removes, scrubs and accounts for everything the fixture planted/,
      ),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("deidentification-guards", [
    ["npx", ["vitest", "run", UNIT_TEST]],
    ["npx", ["vitest", "run", INTEGRATION_TEST]],
    ["npx", ["vitest", "run", RACE_TEST]],
  ]);
  await runProbes(probes);
}
