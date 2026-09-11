/*
 * Rule 36 probes for the reindex path's refusal.
 *
 * A SECOND DESTRUCTIVE SURFACE, and the reason it gets its own suite. `reset-guard.mjs` probes the
 * call site in `reset-local.ts`; this one probes the call site in `reindex-search-index.ts`. They
 * are different call sites in front of different destructive operations, and Rule 32 does not let
 * one stand in for the other — presence is not enforcement, and a guard is not wired until
 * something fails when it is REMOVED and when it is MOVED.
 *
 * The destructive operation here is `index.deleteAllDocuments()`. It is recoverable in principle,
 * which is exactly why it is easy to leave unguarded: a rebuild that empties the wrong index and
 * then cannot repopulate it takes the platform's whole catalogue out of search until someone
 * notices that search is quiet.
 *
 * CLASS B, post-state, for the same reason as the reset probes: guarded and unguarded both end in a
 * thrown refusal, so the only honest question is whether the index was emptied first. Each probe
 * plants a document, points the real `npm run search:reindex` at a database named
 * `lombakita_production`, and asks afterwards whether the planted document is still there.
 *
 * LIVES IN THE browser-audits JOB because it needs a Meilisearch, which only that job has — the
 * same reason `browser-audit-refusals.mjs` lives there rather than beside the config gates.
 *
 * Usage: node scripts/testing/probes/reindex-guard.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import {
  PROBE_DATABASES,
  baseDatabaseUrl,
  createProbeDatabase,
  dropProbeDatabase,
  withDatabase,
} from "./throwaway-database.mjs";

const REINDEX = "scripts/reindex-search-index.ts";
const GUARD = "scripts/reset/reset-guard.ts";

/** A protected name, so the identity layer is what has to refuse. */
const PROBE_DATABASE = PROBE_DATABASES.protectedTarget;

/** Planted before each run; its absence afterwards is the whole verdict. */
const PLANTED_ID = "00000000-0000-4000-8000-00000000feed";

/** Printed by the reindex when it reaches the delete. Its absence means nothing was measured. */
const REACHED_THE_DELETE = "[3/4] Emptying the index";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI, where these come from the workflow environment instead.
}

/**
 * Meilisearch's address, resolved when a probe RUNS rather than when this file is imported.
 *
 * `probe-coverage.test.ts` imports every suite as data, in a job that has no Meilisearch, so a
 * module-scope throw here would fail that test rather than this suite. It still REFUSES rather than
 * skipping — a probe suite that skips reports the same green as one that measured — it just refuses
 * at the moment it is asked to measure something.
 */
const meilisearch = () => {
  const host = process.env.MEILISEARCH_HOST;
  const key = process.env.MEILISEARCH_API_KEY;

  if (!host || !key) {
    throw new Error(
      "these probes measure whether a Meilisearch index was emptied, so MEILISEARCH_HOST and " +
        "MEILISEARCH_API_KEY must be set before running them.",
    );
  }

  return { host, key };
};

const meili = async (path, init = {}) => {
  const { host, key } = meilisearch();

  return fetch(`${host}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
};

const settle = async () => {
  // Meilisearch applies writes asynchronously. Polling the document itself is what makes the plant
  // observable before the run starts; a fixed sleep would be a race the probe reports as a verdict.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await plantedDocumentExists()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("the planted document never became visible, so the probe had nothing to measure");
};

const plantedDocumentExists = async () => {
  const response = await meili(`/indexes/competitions/documents/${PLANTED_ID}`);

  return response.status === 200;
};

const plantDocument = async () => {
  await meili("/indexes/competitions/documents", {
    method: "POST",
    body: JSON.stringify([
      {
        id: PLANTED_ID,
        title: "Planted by the reindex guard probe",
        slug: "reindex-guard-probe",
        category: null,
        mode: null,
        deadline: null,
        createdAt: new Date().toISOString(),
        isFeatured: false,
        featuredOrder: null,
        institutionSlug: "probe",
        institutionName: "Probe",
        status: "published",
      },
    ]),
  });

  await settle();
};

/** Documents the index should hold: the rows a rebuild is supposed to put there. */
const publishedCompetitionCount = async () => {
  const sql = postgres(baseDatabaseUrl(), { max: 1, prepare: false });

  try {
    // Mirrors `publishedCompetitionsFilter()`. Pinned against drift by the unit test named in
    // `competition-index-documents.test.ts`, because a teardown asserting the wrong predicate would
    // report a restored index that is missing rows.
    const [row] = await sql`
      select count(*)::int as count
      from competitions
      where status = 'published' and deleted_at is null
    `;

    return row.count;
  } finally {
    await sql.end({ timeout: 5 });
  }
};

const indexedDocumentCount = async () => {
  const response = await meili("/indexes/competitions/stats");

  if (!response.ok) {
    throw new Error(`could not read index stats to confirm the restore (HTTP ${response.status})`);
  }

  const stats = await response.json();

  return stats.numberOfDocuments;
};

/**
 * Restores the index to agree with the real database, and ASSERTS THAT IT DID.
 *
 * Rule 35: this probe empties a shared index, so teardown has to put it back, and the honest way to
 * do that is the tool whose whole job is making the index match the database. Run with the ambient
 * environment (the real database, not the throwaway one) so it rebuilds what was there.
 *
 * THE ASSERTION IS THE POINT. Dropping `spawnSync`'s return value made this a teardown that could
 * not fail: a rebuild that emptied the index and then died before repopulating it left local search
 * silently empty while the suite still printed that every probe went red as claimed. `waitForTask`
 * times out after 30 seconds, so a catalogue large enough to index slowly reaches that on its own.
 * A teardown inside a harness built to prove that checks can fail is the last place to put one that
 * cannot.
 */
const restoreIndex = async () => {
  const result = spawnSync("npm", ["run", "search:reindex"], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(
      "RESTORE FAILED: the index was emptied by this probe and the rebuild exited " +
        `${result.status}, so local search is now empty. Re-run \`npm run search:reindex\`. ` +
        `Tail of its output:\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-800)}`,
    );
  }

  const [indexed, expected] = await Promise.all([
    indexedDocumentCount(),
    publishedCompetitionCount(),
  ]);

  if (indexed !== expected) {
    throw new Error(
      `RESTORE FAILED: the rebuild reported success but the index holds ${indexed} document(s) ` +
        `against ${expected} published competition(s) in the database.`,
    );
  }
};

/**
 * Runs the real reindex against a protected database and reports whether the index was emptied.
 *
 * Teardown is in a `finally` and runs whether the assertion passed, failed or threw: the planted
 * document is removed, the throwaway database is dropped, and the index is rebuilt from the real
 * one.
 */
const indexWasEmptied = async () => {
  await createProbeDatabase(PROBE_DATABASE);
  await plantDocument();

  try {
    const result = spawnSync("npm", ["run", "search:reindex"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: withDatabase(process.env.DATABASE_URL, PROBE_DATABASE),
        MIGRATION_DATABASE_URL: "",
      },
    });

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    // CLAUSE 3 — reached. A run that never attempted the delete has not measured whether the guard
    // stopped it, and must not be read as the guard holding.
    if (!output.includes(REACHED_THE_DELETE)) {
      throw new Error(
        "the reindex never reached the delete step, so nothing was measured. Tail of its output:\n" +
          output.slice(-800),
      );
    }

    const survived = await plantedDocumentExists();

    return {
      refused: !survived,
      evidence: survived
        ? "the planted document survived — the guard refused before the index was emptied"
        : "the planted document is GONE — the reindex emptied the index and refused after",
    };
  } finally {
    await meili(`/indexes/competitions/documents/${PLANTED_ID}`, { method: "DELETE" });
    await dropProbeDatabase(PROBE_DATABASE);
    await restoreIndex();
  }
};

/** The exact call the reindex makes, matched as one unit so a move takes the whole thing. */
const GUARD_CALL =
  "    await assertResetTargetIsDisposable(sql, { appEnv, databaseUrl, redisUrl: null });\n";

export const probes = [
  {
    name: "the reindex refuses a protected database — GUARD REMOVED",
    klass: "B",
    harmfulMove:
      "deleting the check, so a rebuild pointed at production empties the live catalogue out of search",
    files: [REINDEX],
    appliedMarkers: ["// probe: reindex disposability check removed"],
    mutate: () =>
      substituteOnce(REINDEX, GUARD_CALL, "    // probe: reindex disposability check removed\n"),
    detect: async () => indexWasEmptied(),
  },
  {
    name: "the reindex refuses BEFORE emptying the index — GUARD MOVED",
    // The same ordering claim the reset owes, on the surface the reset probes do not cover. Moved
    // below the delete the refusal still fires, still names the right database and still exits
    // non-zero — every signal a detector could read off the output is identical across the move.
    // Only the index differs.
    klass: "B",
    harmfulMove:
      "checking after the delete, so the rebuild refuses having already emptied what the refusal was for",
    files: [REINDEX],
    appliedMarkers: ["// probe: reindex disposability check moved below the delete"],
    mutate: () => {
      substituteOnce(REINDEX, GUARD_CALL, "");
      substituteOnce(
        REINDEX,
        '    await waitForTask(client, cleared.taskUid, "index emptied");\n',
        '    await waitForTask(client, cleared.taskUid, "index emptied");\n' +
          "    // probe: reindex disposability check moved below the delete\n" +
          GUARD_CALL,
      );
    },
    detect: async () => indexWasEmptied(),
  },
  {
    name: "the database-identity layer is what refuses the reindex",
    // Neutering the one layer, rather than the whole guard, on this call site too. The environment
    // and host layers both permit this run, so if the index is emptied the only thing that was
    // stopping it was the name the SERVER reported.
    klass: "B",
    harmfulMove:
      "trusting the connection string's own name instead of the server's, on the surface that empties the catalogue",
    files: [GUARD],
    appliedMarkers: ["// probe: protected-name refusal removed"],
    mutate: () =>
      substituteOnce(
        GUARD,
        "  if (!PROTECTED_DATABASE_NAMES.includes(databaseName)) {\n    return null;\n  }",
        "  // probe: protected-name refusal removed\n  return null;\n  if (!PROTECTED_DATABASE_NAMES.includes(databaseName)) {\n    return null;\n  }",
      ),
    detect: async () => indexWasEmptied(),
  },
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);
}
