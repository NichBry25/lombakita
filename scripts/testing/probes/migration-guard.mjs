/*
 * Rule 36 probes for `npm run db:migrate:guarded`.
 *
 * EVERY REFUSAL BELOW IS THE ONLY THING STANDING BETWEEN A FORGOTTEN FLAG AND A MANAGED DATABASE.
 * The entry point is one command an operator runs by hand and that six no-argument callers run in
 * CI, so "the check fired" is not a thing anyone observes unless it is made to fail on purpose.
 *
 * CLASS D, AND THE CLASS IS DECLARED RATHER THAN ASSUMED. Each refusal here is decided by a PURE
 * function — `planGuardedMigration` from arguments and the environment, `findTargetRefusal` from the
 * identity the caller read — and each mutation lands in that function. The detector reads the
 * function's RESULT CONTENT, which is what makes it class D. That the runner would otherwise spawn
 * the migrator is the HARM the guard exists to prevent, and it is named in `harmfulMove`; it is not
 * what the detector measures, because a probe whose detector measures a different layer than its
 * mutation is red for a reason it did not claim (Rule 36 clause 8). The spawn-order half is covered
 * separately, and correctly, by the two runner cases that read post-state: the target line printed
 * before a refusal, and `spawnSync` never called.
 *
 * POLARITY FLIPS RATHER THAN REMOVALS, wherever the branch body carries an import or a narrowed
 * binding the rest of the function still needs. A flip produces the harmful behaviour exactly — the
 * input the guard exists to stop is waved through — while leaving every type and every reference in
 * place, so the mutation compiles for a reason rather than by luck.
 *
 * Usage: node scripts/testing/probes/migration-guard.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const GUARD = "src/server/scripts/migration-guard.ts";
const TEST = "src/server/scripts/migration-guard.test.ts";

/** The named case that must go red, so a crashed run cannot be read as a refusal. */
const caseNamed = (pattern) => fails("npx", ["vitest", "run", TEST], pattern);

export const probes = [
  {
    name: "an unknown --environment is refused rather than treated as declared",
    klass: "D",
    harmfulMove:
      "a typo in the environment flag (" +
      '"--environment=staging") resolving to a managed environment instead of being refused, so ' +
      "the run skips the local loopback and protected-name checks it did not ask for and reaches " +
      "the migrator with only whatever --confirm happens to be present",
    files: [GUARD],
    // The type predicate answers `true` for everything. The `--environment` value then narrows to
    // `DeclaredEnvironment` for the compiler exactly as it does today, so the file still type-checks
    // and the mutation measures the guard rather than a syntax error.
    appliedMarkers: ["return ACCEPTED_ENVIRONMENTS.length >= 0;"],
    mutate: () =>
      substituteOnce(
        GUARD,
        "  return ACCEPTED_ENVIRONMENTS.some((candidate) => candidate === value);",
        "  return ACCEPTED_ENVIRONMENTS.length >= 0;",
      ),
    detect: async () => caseNamed(/× .*refuses an unknown environment with a usage line/),
  },
  {
    name: "CONFIRM_PROD_MIGRATION refuses on presence alone",
    klass: "D",
    harmfulMove:
      "a variable that used to authorise production migrations being read again, from a shell " +
      "profile or a pulled env file that outlives the intent that put it there — a stored value " +
      "satisfying an act of confirmation on the operator's behalf (LAUNCH-D151)",
    files: [GUARD],
    // The refusal removed outright. Its body is a single `return`, so nothing below depends on
    // narrowing here and the block's absence is the harmful behaviour with no other consequence.
    appliedMarkers: ["if (false) {"],
    mutate: () =>
      substituteOnce(
        GUARD,
        "if (input.env.CONFIRM_PROD_MIGRATION !== undefined) {",
        "if (false) {",
      ),
    detect: async () =>
      caseNamed(/× .*refuses on presence alone, even carrying the value that used to authorise/),
  },
  {
    name: "a declared environment requires the typed confirmation",
    klass: "D",
    harmfulMove:
      "preview or production migrating with no --confirm at all, which is every stored-environment " +
      "path the typed confirmation was introduced to replace: the operator declares the environment " +
      "and nothing else has to be true",
    files: [GUARD],
    appliedMarkers: ["if (false) {"],
    mutate: () =>
      substituteOnce(GUARD, 'if (environment !== "local" && confirm === null) {', "if (false) {"),
    detect: async () => caseNamed(/× .*refuses production without --confirm/),
  },
  {
    name: "the default environment refuses a host that is not loopback",
    klass: "D",
    harmfulMove:
      "a run with no --environment against a remote host, which is the shape a stale exported " +
      "MIGRATION_DATABASE_URL produces: the operator believes they are migrating locally and the " +
      "migrator is pointed at a managed database (LAUNCH-D151)",
    files: [GUARD],
    // Flipped. With `if (false)` the branch body's uses of `plan.variable` and `parseDatabaseHost`
    // would be the only ones in the function, and the mutation would be measuring whether the file
    // still compiles.
    appliedMarkers: ["if (isLoopbackUrl(plan.url)) {"],
    mutate: () =>
      substituteOnce(GUARD, "if (!isLoopbackUrl(plan.url)) {", "if (isLoopbackUrl(plan.url)) {"),
    detect: async () => caseNamed(/× .*refuses a non-loopback host/),
  },
  {
    name: "the default environment refuses a deployed database by the SERVER's name for it",
    klass: "D",
    harmfulMove:
      "a loopback-looking connection whose server reports one of the deployed database names, so " +
      "the one check that cannot be satisfied by editing a connection string stops applying " +
      "(DEC-0207)",
    files: [GUARD],
    appliedMarkers: ["if (!PROTECTED_DATABASE_NAMES.includes(identity.database)) {"],
    mutate: () =>
      substituteOnce(
        GUARD,
        "if (PROTECTED_DATABASE_NAMES.includes(identity.database)) {",
        "if (!PROTECTED_DATABASE_NAMES.includes(identity.database)) {",
      ),
    detect: async () =>
      caseNamed(/× .*refuses a database the SERVER says is one of the deployed names/),
  },
  {
    name: "a declared environment refuses a server that is not the one it declared",
    klass: "D",
    harmfulMove:
      "migrating whichever database the credential actually reaches: the name and the role are " +
      "both taken on trust from the connection string, which is the fault DEC-0207 exists for — " +
      "Railway production's migration credential named and hosted staging while every layer agreed " +
      "with it",
    files: [GUARD],
    appliedMarkers: [
      "if (identityMismatch(identity, { database: expectedDatabase, role: expectedRole }) === null) {",
    ],
    mutate: () =>
      substituteOnce(
        GUARD,
        "if (identityMismatch(identity, { database: expectedDatabase, role: expectedRole }) !== null) {",
        "if (identityMismatch(identity, { database: expectedDatabase, role: expectedRole }) === null) {",
      ),
    detect: async () => caseNamed(/× .*refuses a role mismatch on the right database/),
  },
  {
    name: "the typed confirmation is compared with the server's answer, not with a constant",
    klass: "D",
    harmfulMove:
      "--confirm satisfying the gate with a name that is not the one the server reported, which " +
      "turns the confirmation back into a value read out of configuration rather than typed by " +
      "the operator against what the server said",
    files: [GUARD],
    appliedMarkers: ["if (plan.confirm === identity.database) {"],
    mutate: () =>
      substituteOnce(
        GUARD,
        "if (plan.confirm !== identity.database) {",
        "if (plan.confirm === identity.database) {",
      ),
    detect: async () =>
      caseNamed(/× .*refuses a --confirm naming the other environment's database/),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("migration-guard", [["npx", ["vitest", "run", TEST]]]);
  await runProbes(probes);
}
