/*
 * Rule 36 probes for the from-zero reset path's refusal.
 *
 * The reset drops every table in the database it is pointed at. Nothing undoes that, so the guard
 * in front of it is the only thing standing between a mistyped connection string and the platform's
 * only real accounts. A guard nobody has watched refuse is a guard that has been ASSUMED.
 *
 * CLASS B throughout: a guard before a write, with no transaction around it, so rollback restores
 * nothing and the detector must be the POST-STATE. Reading the error would be worthless here —
 * every one of these runs ends in a thrown refusal whether the guard ran before the drop or after
 * it, and the whole question is which. So each probe creates a real database with a marker table in
 * it, points the real `npm run db:reset` at it, and asks afterwards whether the marker is still
 * there. Guarded, it is. Unguarded, the drop already happened and the refusal came too late to be
 * one.
 *
 * ALL THREE LAYERS ARE PROBED. An earlier version of this header claimed the connection-host
 * layer's removal had no observable post-state and that showing otherwise would need a real remote
 * database to destroy. Both halves were wrong. The identity layer only refuses a CANONICALLY NAMED
 * database, so a non-loopback address aimed at any other name reaches it unopposed; and the local
 * server answers on `0.0.0.0` and on its LAN address as readily as on `localhost`, none of which
 * `isLoopbackUrl` recognises. So a non-loopback STRING and a local throwaway DATABASE are the same
 * server, and the probe costs nothing but the address it dials.
 *
 * Rule 32 permits a stated absence with a reason. It does not permit one with a wrong reason: an
 * unexamined impossibility claim is the same defect as a probe reporting a result it never
 * measured, one level up.
 *
 * Usage: node scripts/testing/probes/reset-guard.mjs
 * Requires a reachable local Postgres whose role may CREATE DATABASE.
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import {
  MARKER_TABLE,
  PROBE_DATABASES,
  baseDatabaseUrl,
  createProbeDatabase,
  dropProbeDatabase,
  markerSurvives,
  withDatabase,
} from "./throwaway-database.mjs";

const RESET = "scripts/reset/reset-local.ts";
const GUARD = "scripts/reset/reset-guard.ts";

/**
 * The line the reset prints when it reaches the drop, derived from the reset's own source.
 *
 * Nothing about it is pinned. The step number, the total, the title and the print format all belong
 * to `reset-local.ts`, and a fixture restating any of them asserts a value the code is free to move
 * — which is how this probe stopped measuring anything on 2026-09-14, when the reset grew a seventh
 * step and the expectation it compared against stayed at `[2/6]`.
 *
 * Read per run rather than once at import, and refused rather than guessed when an anchor is absent
 * (Rule 38). A probe that cannot derive its subject has not measured it, and must not report as if
 * it had.
 *
 * Exported so what it derives can be read without running a reset that drops a database.
 */
export const reachedTheDropLine = () => {
  const source = readFileSync(RESET, "utf8");
  const print = source.match(/console\.log\(`([^`]*\$\{number\}[^`]*)`\)/);
  const total = source.match(/^const TOTAL_STEPS = (\d+);$/m);
  const drop = source.match(/^\s*step\((\d+), "(Dropping[^"]*)"\);$/m);

  for (const [anchor, found] of [
    ["the step helper's print template", print],
    ["TOTAL_STEPS", total],
    ["the step(…) call that drops every migrated object", drop],
  ]) {
    if (found === null) {
      throw new Error(
        `cannot derive the line the reset prints when it reaches the drop: ${anchor} is not in ` +
          `${RESET}. Refusing rather than comparing against a guess.`,
      );
    }
  }

  // A bracketed line is the contract `step()` prints. Without one, the reached-the-drop line could
  // not be told apart from anything else the reset writes, so the probe refuses rather than match
  // on a fragment that happens to appear.
  if (!print[1].includes("[")) {
    throw new Error(
      `the step helper's print template in ${RESET} carries no bracket, so the reached-the-drop ` +
        `line cannot be told apart from the rest of the output: \`${print[1]}\`. Refusing.`,
    );
  }

  return print[1]
    .slice(print[1].indexOf("["))
    .replace("${number}", drop[1])
    .replace("${TOTAL_STEPS}", total[1])
    .replace("${title}", drop[2]);
};

try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI, where these come from the workflow environment instead.
}

// Resolved per run, not at import: `probe-coverage.test.ts` imports every suite as data, and a
// module-scope throw would fail that test rather than this suite.

/**
 * The same server, addressed in a way `isLoopbackUrl` does not recognise.
 *
 * `0.0.0.0` reaches a Postgres listening on all interfaces exactly as `localhost` does, so the
 * connection-host probe destroys a throwaway on this machine rather than needing a remote database.
 * The parent's own environment is untouched, so the harness guard still sees loopback and permits
 * creating and dropping the throwaway; only the CHILD dials the unrecognised address.
 */
const atNonLoopbackAddress = (url) => {
  const parsed = new URL(url);
  parsed.hostname = "0.0.0.0";

  return parsed.toString();
};

/**
 * Runs the real reset against a throwaway database and reports whether the drop happened.
 *
 * MEILISEARCH_HOST and REDIS_URL are blanked for the child on purpose: with the guard removed the
 * reset runs to completion, and the steps after the drop would empty the developer's search index
 * and flush their Redis. The experiment is about the drop; the rest is collateral.
 *
 * Teardown is in a `finally` (Rule 35), and it drops the database whether the assertion passed,
 * failed, or threw.
 */
const dropHappenedAgainst = async (databaseName, environment, { nonLoopback = false } = {}) => {
  // Derived before anything is created or dropped. Without it the run cannot be judged, and
  // discovering that afterwards would mean having run a destroying reset for nothing.
  const reachedTheDrop = reachedTheDropLine();

  const baseUrl = baseDatabaseUrl();
  const childUrl = withDatabase(
    nonLoopback ? atNonLoopbackAddress(baseUrl) : baseUrl,
    databaseName,
  );

  await createProbeDatabase(databaseName);

  try {
    const result = spawnSync("npm", ["run", "db:reset"], {
      encoding: "utf8",
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: childUrl,
        DATABASE_URL: childUrl,
        MEILISEARCH_HOST: "",
        REDIS_URL: "",
        ...environment,
      },
    });

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    // CLAUSE 3 — reached. A run that never got as far as attempting the drop has not measured
    // whether the guard stopped it, and must not be read as the guard holding.
    if (!output.includes(reachedTheDrop)) {
      throw new Error(
        `the reset never reached the drop step, so nothing was measured. Tail of its output:\n` +
          output.slice(-800),
      );
    }

    const survived = await markerSurvives(databaseName);

    return {
      refused: !survived,
      evidence: survived
        ? `${MARKER_TABLE} survived in "${databaseName}" — the guard refused before the drop`
        : `${MARKER_TABLE} is GONE from "${databaseName}" — the reset dropped it and refused after`,
    };
  } finally {
    await dropProbeDatabase(databaseName);
  }
};

/** The exact call the reset makes, matched as one unit so a move takes the whole thing. */
const GUARD_CALL =
  "    await assertResetTargetIsDisposable(sql, {\n" +
  '      verb: "reset",\n' +
  "      appEnv,\n" +
  "      databaseUrl: target,\n" +
  "      redisUrl: optionalUrl(process.env.REDIS_URL),\n" +
  "    });\n";

export const probes = [
  {
    name: "the reset refuses a protected database — GUARD REMOVED",
    klass: "B",
    harmfulMove:
      "deleting the check, so a reset pointed at production drops all 53 tables and reports the failure afterwards",
    files: [RESET],
    appliedMarkers: ["// probe: disposability check removed"],
    mutate: () => substituteOnce(RESET, GUARD_CALL, "    // probe: disposability check removed\n"),
    detect: async () => dropHappenedAgainst(PROBE_DATABASES.protectedTarget, {}),
  },
  {
    name: "the reset refuses BEFORE dropping anything — GUARD MOVED",
    // THE PROBE THIS STEP OWES. Block B's `checkOptionalBound` sat block-scoped inside an `if`,
    // where relocating it would not compile — so a move test would have passed forever while
    // proving nothing about ordering. This guard takes only `sql` and returns nothing the drop
    // needs, so moving it below the drop compiles and runs. The refusal still fires, still names
    // the right database, and still exits non-zero: every signal a detector could read off the
    // output is identical across the move. Only the database differs, which is why the post-state
    // is the only honest detector here.
    klass: "B",
    harmfulMove:
      "checking after the drop, so the run refuses having already destroyed what the refusal was for",
    files: [RESET],
    appliedMarkers: ["// probe: disposability check moved below the drop"],
    mutate: () => {
      substituteOnce(RESET, GUARD_CALL, "");
      substituteOnce(
        RESET,
        "    await dropEveryMigratedObject(sql);\n",
        "    await dropEveryMigratedObject(sql);\n" +
          "    // probe: disposability check moved below the drop\n" +
          GUARD_CALL,
      );
    },
    detect: async () => dropHappenedAgainst(PROBE_DATABASES.protectedTarget, {}),
  },
  {
    name: "the database-identity layer is what refuses a protected name",
    // Neutering this one LAYER, rather than the whole guard, is what shows it carries its own
    // weight. The environment and host layers both permit this run — APP_ENV is local and the
    // server is loopback — so if the drop happens, the only thing that was stopping it was the name
    // the SERVER reported.
    klass: "B",
    harmfulMove:
      "trusting the connection string's own name instead of the server's, which is LAUNCH-D24 exactly",
    files: [GUARD],
    appliedMarkers: ["// probe: protected-name refusal removed"],
    mutate: () =>
      substituteOnce(
        GUARD,
        "  if (!PROTECTED_DATABASE_NAMES.includes(databaseName)) {\n    return null;\n  }",
        "  // probe: protected-name refusal removed\n  return null;\n  if (!PROTECTED_DATABASE_NAMES.includes(databaseName)) {\n    return null;\n  }",
      ),
    detect: async () => dropHappenedAgainst(PROBE_DATABASES.protectedTarget, {}),
  },
  {
    name: "the environment layer is what refuses a production process",
    // The mirror image: a database name nothing protects, reached from a process that believes it
    // is production. Only the environment layer objects, so the drop happening means it was the
    // one holding the line. This is the case a name-based check alone cannot see — a production
    // deployment whose database is not called what the deploy gate expects.
    klass: "B",
    harmfulMove:
      "permitting any environment, so a production process resets whichever database it is pointed at",
    files: [GUARD],
    appliedMarkers: ["// probe: environment allow-list removed"],
    mutate: () =>
      substituteOnce(
        GUARD,
        "  if (DISPOSABLE_ENVIRONMENTS.includes(appEnv)) {\n    return null;\n  }",
        "  // probe: environment allow-list removed\n  return null;\n  if (DISPOSABLE_ENVIRONMENTS.includes(appEnv)) {\n    return null;\n  }",
      ),
    detect: async () =>
      dropHappenedAgainst(PROBE_DATABASES.unprotectedTarget, { APP_ENV: "production" }),
  },
  {
    name: "the connection-host layer is what refuses a non-loopback address — GUARD REMOVED",
    // The third layer, and the one whose probe was once declared impossible. The throwaway carries
    // a name nothing protects and the environment resolves to local, so identity and environment
    // both permit; the only thing standing between this run and the drop is the address it dialled.
    klass: "B",
    harmfulMove:
      "deleting the host check, so a reset reaches a database through a tunnelled or remote address",
    files: [GUARD],
    appliedMarkers: ["// probe: connection-host refusal removed"],
    mutate: () =>
      substituteOnce(
        GUARD,
        '  refuseIf(findConnectionHostRefusal(context.verb, context.databaseUrl, "DATABASE_URL"));\n',
        "  // probe: connection-host refusal removed\n",
      ),
    detect: async () =>
      dropHappenedAgainst(PROBE_DATABASES.hostProbeTarget, {}, { nonLoopback: true }),
  },
];

// Exported as DATA and run only when this file IS the entry point, so a test can read the probe set
// without mutating the tree to find out.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);
}
