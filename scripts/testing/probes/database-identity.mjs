/*
 * Rule 36 probes for the deploy gate's RUNTIME database identity check.
 *
 * WHAT THIS CHECK IS THE ONLY THING STANDING IN FRONT OF. `migration-guard.mjs` covers the lane that
 * MIGRATES; this covers the lane the app SERVES from. Both ask the server which database and which
 * role they reached (DEC-0207), because a connection string's own name and user are the claim under
 * test and every layer that never asks the server agrees with them.
 *
 * CLASS D, AND THE CLASS IS DECLARED RATHER THAN ASSUMED. Every guard here is a comparison or a
 * branch whose effect is the CONTENT of a result: `assertDatabaseIdentity` resolves or throws,
 * `getConnectorStatusPayload` includes one entry or does not, and `declaredEnvironmentFromFlag`
 * returns a value or nothing. Each mutation lands in that decision and the detector reads the result,
 * which is what makes them class D. That a real connection to the wrong database would have been
 * opened is the HARM, named in `harmfulMove`; it is not what a detector measures, because a probe
 * whose detector measures a different layer than its mutation is red for a reason it did not claim
 * (clause 8).
 *
 * TWO GUARDS HERE FAIL BY NEVER FIRING RATHER THAN BY PASSING SOMETHING THROUGH. A declaration that
 * is never made, or a branch that never runs, leaves the check silently absent — the LAUNCH-D150
 * class this whole block exists to close — so those two probes are written to remove the declaring
 * rather than to widen it, and the widening is probed separately.
 *
 * POLARITY FLIPS RATHER THAN REMOVALS where the branch body carries an import or a narrowed binding,
 * so the mutation compiles for a reason rather than by luck (clause 1).
 *
 * Usage: node scripts/testing/probes/database-identity.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const PROBE = "src/server/db/database-identity-probe.ts";
const PROBE_TEST = "src/server/db/database-identity-probe.test.ts";
const STATUS = "src/server/connectors/status.ts";
const STATUS_TEST = "src/server/connectors/status.test.ts";
const CLI = "src/server/scripts/connectors-status.ts";
const CLI_TEST = "src/server/scripts/connectors-status.test.ts";

export const probes = [
  {
    name: "a server answering as the wrong role is refused, not reported as a match",
    klass: "D",
    harmfulMove:
      "the runtime lane accepting whichever role its credential happens to hold: the right database " +
      "reached as the migration role, which is a credential that can do a different set of things " +
      "there than the app assumes, and the one difference the database-name comparison cannot see " +
      "(DEC-0207)",
    files: [PROBE],
    // The refusal's EFFECT removed, not its condition rewritten. Rewriting the condition drops the
    // narrowing `new Error(mismatch)` depends on — `mismatch` reverts to `string | null`, the call
    // stops compiling, and the probe measures a type error instead of the guard (clause 1).
    // Returning in place of the throw is the harm exactly: the mismatch is computed and then
    // reported as nothing, with every type and every reference left standing.
    appliedMarkers: ["  if (mismatch !== null) {\n    return;"],
    mutate: () => substituteOnce(PROBE, "    throw new Error(mismatch);", "    return;"),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", PROBE_TEST],
        /× .*refuses a server answering as the migration role/,
      ),
  },
  {
    name: "the database the server names is compared, not only the role",
    klass: "D",
    harmfulMove:
      "a lane that reached the wrong DATABASE entirely and asked only about the role: the fault " +
      "DEC-0207 exists for, since a migration and a runtime credential for the same database share " +
      "a role name, so the comparison that no longer happens is the one that catches it",
    files: [PROBE],
    // The field supplied as `undefined` rather than removed: `identityMismatch` treats an absent
    // expectation as one it must say nothing about, so the comparison is genuinely gone while every
    // type and every reference in the call stays in place.
    appliedMarkers: ["    database: undefined,"],
    mutate: () =>
      substituteOnce(
        PROBE,
        "    database: CANONICAL_DATABASE_NAME[environment],",
        "    database: undefined,",
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", PROBE_TEST],
        /× .*refuses a server answering from the wrong database/,
      ),
  },
  {
    name: "the runtime lane expects the RUNTIME role, not the migration role",
    klass: "D",
    harmfulMove:
      "the two roles in the pinned map transposed, so the check refuses the production runtime that " +
      "is correct and passes the migration credential the whole check exists to distrust — one " +
      "keystroke away, because both values sit on the same object",
    files: [PROBE],
    appliedMarkers: ["    role: CANONICAL_DATABASE_ROLE[environment].migration,"],
    mutate: () =>
      substituteOnce(
        PROBE,
        "    role: CANONICAL_DATABASE_ROLE[environment].runtime,",
        "    role: CANONICAL_DATABASE_ROLE[environment].migration,",
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", PROBE_TEST],
        /× .*passes when the server answers as the declared environment's database and runtime role/,
      ),
  },
  {
    name: "a caller that declared no environment gets no check rather than an invented one",
    klass: "D",
    harmfulMove:
      "an undeclared environment being filled in with a default AT THE POINT IT IS READ, so a run " +
      "that declared nothing is checked against production — an expectation the caller never stated, " +
      "asserted on its behalf, on the health endpoint as much as the gate",
    files: [STATUS],
    // The default belongs in the destructuring rather than at the call, and that is the whole reason
    // this probe is written this way. Substituting a fallback at `probeDatabaseIdentity(...)` leaves
    // the guard above it false, so the call is never reached and the probe measures nothing — which
    // it did, and was reported NOT PROVEN. Defaulted here, the value is filled in before every use,
    // which is the harm and is reachable.
    appliedMarkers: ['declaredEnvironment = "production" } = options;'],
    mutate: () =>
      substituteOnce(
        STATUS,
        "  const { includeLiveChecks, includeWorkerLiveness, declaredEnvironment } = options;",
        '  const { includeLiveChecks, includeWorkerLiveness, declaredEnvironment = "production" } = options;',
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", STATUS_TEST],
        /× .*does not run when no environment was declared/,
      ),
  },
  {
    name: "the identity check is not run when live checks are off",
    klass: "D",
    harmfulMove:
      "the configuration-only run opening a database connection anyway: the gate's cheap layer " +
      "acquiring the network side effect of its live layer, on a command whose contract is that it " +
      "touches nothing",
    files: [STATUS],
    appliedMarkers: ["  if (declaredEnvironment !== undefined) {"],
    mutate: () =>
      substituteOnce(
        STATUS,
        "  if (includeLiveChecks && declaredEnvironment !== undefined) {",
        "  if (declaredEnvironment !== undefined) {",
      ),
    detect: async () =>
      fails("npx", ["vitest", "run", STATUS_TEST], /× .*does not run when live checks are off/),
  },
  {
    name: "a declared environment reaches the check rather than being narrowed away",
    klass: "D",
    harmfulMove:
      "the mapping returning nothing for every input, so the deploy gate declares an environment and " +
      "the identity check silently never runs — a check that is present in the source and absent from " +
      "every run (LAUNCH-D150)",
    files: [CLI],
    appliedMarkers: ['  value === "preview" || value === "production" ? undefined : undefined;'],
    mutate: () =>
      substituteOnce(
        CLI,
        '  value === "preview" || value === "production" ? value : undefined;',
        '  value === "preview" || value === "production" ? undefined : undefined;',
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", CLI_TEST],
        /× .*passes preview through as a declared environment/,
      ),
  },
  {
    name: "a value that is not a deployed environment is not declared as one",
    klass: "D",
    harmfulMove:
      "`--environment=staging` passed through as a declaration, so the check asserts against an " +
      "environment this codebase has no canonical database or role for — the value interpreted " +
      "instead of refused",
    files: [CLI],
    appliedMarkers: ["? value : (value as DeployEnvironment);"],
    mutate: () =>
      substituteOnce(
        CLI,
        '  value === "preview" || value === "production" ? value : undefined;',
        '  value === "preview" || value === "production" ? value : (value as DeployEnvironment);',
      ),
    detect: async () =>
      fails("npx", ["vitest", "run", CLI_TEST], /× .*passes nothing for any other value/),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("database-identity", [
    ["npx", ["vitest", "run", PROBE_TEST]],
    ["npx", ["vitest", "run", STATUS_TEST]],
    ["npx", ["vitest", "run", CLI_TEST]],
  ]);
  await runProbes(probes);
}
