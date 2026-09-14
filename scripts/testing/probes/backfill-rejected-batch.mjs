/*
 * Rule 36 probes for the search backfill's outcome check.
 *
 * THE DEFECT THIS MEASURES IS A SCRIPT THAT REPORTS A COUNT IT NEVER MEASURED. Meilisearch accepts
 * a document batch and reports the outcome ASYNCHRONOUSLY, so `addDocuments` returns a task uid
 * whatever happens next. `backfill-search-index.ts` printed `Upserted N document(s)` off that uid,
 * which means a batch where every document was rejected produced the same line, the same exit 0 and
 * the same operator confidence as a batch that landed. Nothing about the run said which had
 * happened, and the run is the only thing anyone reads.
 *
 * THE REJECTION IS INDUCED FROM THE ENVIRONMENT, NOT BY EDITING THE BATCH. That matters: a rejection
 * that only happens because the probe also broke the input proves the probe, not the guard
 * (Rule 33). Meilisearch refuses a document batch aimed at an index whose primary key differs from
 * the one the batch declares, and it refuses it as a TASK — HTTP 202, a uid, and `failed` a moment
 * later. That is exactly the shape the defect is blind to, and it is reachable by pointing the real
 * script at a real index and changing nothing else.
 *
 * TWO MEASUREMENTS, AND THE FIRST IS THE ONE THE PHASE ASKS FOR:
 *
 *   1. CONTROL — the committed script, unmutated, against the refusing index. It must go RED and
 *      name the task refusal. This is "the repaired path is red on a rejected batch", measured on
 *      the code that is actually on disk rather than inferred from the probe.
 *   2. PROBE — the same run with the outcome check REMOVED, which is the shape the file had before.
 *      It must go GREEN: exit 0, print the success line, and leave an empty index behind. If it
 *      still refused, the outcome check is not what was refusing and the repair is somewhere else.
 *
 * CLASS B (Rule 36). There is no transaction to roll back and no request-path guard to move: the
 * question is the POST-STATE — did the run report an outcome the index contradicts. The detector
 * reads the process's exit status and the index's own document count, and never treats one as
 * evidence for the other.
 *
 * RULE 35. This probe deletes and recreates the `competitions` index in a live Meilisearch. Teardown
 * is in a `finally` around each measurement — not around the suite, because `runProbes` calls
 * `process.exit` and a teardown there would be skipped by exactly the failure it exists for. It
 * restores the index with the tool whose whole job is making the index match the database, and
 * asserts what survived: a teardown that cannot fail is the last thing to put inside a harness built
 * to prove that checks can fail.
 *
 * Usage: npm run verify:backfill-probe
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { runProbes, substituteOnce } from "../guard-probe.mjs";

const BACKFILL = "scripts/backfill-search-index.ts";
const INDEX = "competitions";

/** The primary key the probe gives the index, so the backfill's own declaration disagrees with it. */
const CONFLICTING_PRIMARY_KEY = "slug";

/**
 * Proof the run got as far as handing Meilisearch a batch.
 *
 * The document count, not the success line. The repaired script never reaches its own success line
 * on a rejected batch — it throws first — so a marker keyed to that line would report every correct
 * refusal as "nothing was measured". This one is emitted by both shapes: the repaired script's
 * failure names the task by its label (`Task "upserted 15 document(s)" failed`), and the un-repaired
 * one prints the label into its success line.
 */
const REACHED_THE_BATCH = /upserted \d+ document\(s\)/i;

/**
 * The line the un-repaired script printed whatever Meilisearch did with the batch.
 *
 * Anchored to the uid, so it cannot be satisfied by the repaired script's read-back line or by the
 * failure message, neither of which claims the batch landed.
 */
const CLAIMED_SUCCESS = /^Upserted \d+ document\(s\)\. Meilisearch task uid:/m;

/** Meilisearch's own verdict, quoted so the detector names the refusal it observed. */
const TASK_REFUSAL = "index_primary_key_already_exists";

const READ_BACK_FROM = "  const written = await index.getDocuments({";
const READ_BACK_TO = "  console.log(`Upserted ${documents.length} document(s) and read them back.`);";

/** The line the outcome check replaced, restored by the probe to reproduce the defect. */
const CLAIM_WITHOUT_MEASURING =
  "  console.log(`Upserted ${documents.length} document(s). Meilisearch task uid: ${task.taskUid}`);";

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
 * skipping — a probe suite that skips reports the same green as one that measured.
 */
const meilisearch = () => {
  const host = process.env.MEILISEARCH_HOST;
  const key = process.env.MEILISEARCH_API_KEY;

  if (!host || !key) {
    throw new Error(
      "these probes measure whether a rejected batch is reported as success, so MEILISEARCH_HOST " +
        "and MEILISEARCH_API_KEY must be set before running them.",
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

/**
 * Waits for one Meilisearch task to stop being `enqueued` or `processing`.
 *
 * Index creation and deletion are enqueued like everything else, so a probe that POSTs and then
 * immediately reads would race the server and report the race as a verdict.
 */
const settle = async (taskUid) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const task = await (await meili(`/tasks/${taskUid}`)).json();

    if (task.status !== "enqueued" && task.status !== "processing") return task;

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`task ${taskUid} never settled, so the probe had nothing to measure`);
};

const enqueue = async (path, init) => {
  const response = await meili(path, init);

  if (!response.ok) {
    throw new Error(
      `probe setup failed: ${init?.method ?? "GET"} ${path} → HTTP ${response.status}`,
    );
  }

  return (await response.json()).taskUid;
};

/**
 * Replaces the index with one whose primary key contradicts what the backfill declares.
 *
 * The database is untouched and the script is untouched. The ONLY difference between this and a
 * healthy run is a property of the index, which is what makes the induced rejection evidence about
 * the script rather than about the probe.
 */
const giveIndexAConflictingPrimaryKey = async () => {
  await settle(await enqueue(`/indexes/${INDEX}`, { method: "DELETE" }));
  await settle(
    await enqueue("/indexes", {
      method: "POST",
      body: JSON.stringify({ uid: INDEX, primaryKey: CONFLICTING_PRIMARY_KEY }),
    }),
  );
};

const indexDocumentCount = async () => {
  const response = await meili(`/indexes/${INDEX}/stats`);

  if (!response.ok) {
    throw new Error(`could not read the index's document count (HTTP ${response.status})`);
  }

  return (await response.json()).numberOfDocuments;
};

const runBackfill = () => {
  const result = spawnSync("node", ["--import", "tsx", BACKFILL], { encoding: "utf8" });

  return { output: `${result.stdout ?? ""}${result.stderr ?? ""}`, status: result.status };
};

const publishedCompetitionCount = async () => {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, idle_timeout: 5 });

  try {
    const [row] = await sql`
      SELECT count(*)::int AS total FROM competitions WHERE status = 'published'`;

    return row.total;
  } finally {
    await sql.end({ timeout: 5 });
  }
};

/**
 * Puts the index back, and asserts it went back.
 *
 * The probe leaves the index carrying a primary key the platform never uses, holding nothing. The
 * restore deletes it outright — a rebuild cannot change an existing index's primary key, so
 * tolerating the index is not an option — and lets `search:reindex` recreate and repopulate it.
 */
const restoreIndex = async () => {
  await settle(await enqueue(`/indexes/${INDEX}`, { method: "DELETE" }));

  const result = spawnSync("npm", ["run", "search:reindex"], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(
      "RESTORE FAILED: this probe deleted the competitions index and the rebuild exited " +
        `${result.status}, so local search is now empty. Re-run \`npm run search:reindex\`. ` +
        `Tail of its output:\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-800)}`,
    );
  }

  const [indexed, expected] = await Promise.all([indexDocumentCount(), publishedCompetitionCount()]);

  if (indexed !== expected) {
    throw new Error(
      `RESTORE FAILED: the rebuild reported success but the index holds ${indexed} document(s) ` +
        `against ${expected} published competition(s) in the database.`,
    );
  }
};

/**
 * Runs the backfill against a refusing index and reports what it said and what the index holds.
 *
 * The index's document count is read BEFORE the teardown rebuilds it, and the two facts are
 * returned separately so the caller decides what they mean rather than the runner deciding.
 */
const backfillAgainstARefusingIndex = async () => {
  try {
    await giveIndexAConflictingPrimaryKey();

    const run = runBackfill();

    // CLAUSE 3 — reached. A run that never read the database has not measured what the outcome check
    // does with a rejected batch, and must not be read as either outcome. The control and the probe
    // reach the same line, so this refuses both for the same reason.
    if (run.output.includes("No published competitions found")) {
      throw new Error(
        "the database holds no published competitions, so there is no batch to reject and this " +
          "run measured nothing. Seed the matrix and try again.",
      );
    }

    if (!REACHED_THE_BATCH.test(run.output)) {
      throw new Error(
        "the backfill never reached the batch, so nothing was measured. Tail of its output:\n" +
          run.output.slice(-800),
      );
    }

    const documentsIndexed = await indexDocumentCount();

    return {
      claimedSuccess: CLAIMED_SUCCESS.test(run.output),
      documentsIndexed,
      output: run.output,
      status: run.status,
    };
  } finally {
    await restoreIndex();
  }
};

/**
 * MEASUREMENT 1 — the committed script, unmutated.
 *
 * Run before the probe suite rather than inside it, because the harness mutates before every
 * detector runs and there is no state in which it hands a detector the file as it stands. This is
 * the run the phase asked for: the repaired path, red, on a batch Meilisearch rejected.
 */
const proveTheCommittedPathIsRed = async () => {
  const run = await backfillAgainstARefusingIndex();

  if (run.status === 0 || run.claimedSuccess) {
    throw new Error(
      "the committed backfill reported success on a rejected batch, so the repair is not on disk. " +
        `Output:\n${run.output.slice(-800)}`,
    );
  }

  if (!run.output.includes(TASK_REFUSAL)) {
    throw new Error(
      "the committed backfill went red for some reason other than the task refusal, so this run " +
        `says nothing about the outcome check. Output:\n${run.output.slice(-800)}`,
    );
  }

  console.log(
    "control  the committed backfill on a rejected batch: REFUSED, naming " +
      `\`${TASK_REFUSAL}\`, with the index left holding ${run.documentsIndexed} document(s)\n` +
      "         — the pathological run is red, and red for the reason claimed\n",
  );
};

/**
 * The outcome check as it stands on disk, read from the file rather than retyped.
 *
 * Read rather than inlined so the probe cannot drift from the code it removes: if the block is
 * edited, `substituteOnce` fails loudly instead of mutating something adjacent and measuring it.
 */
const readBackBlock = () => {
  const source = readFileSync(BACKFILL, "utf8");
  const start = source.indexOf(READ_BACK_FROM);
  const end = source.indexOf(READ_BACK_TO);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      "the backfill's outcome check is not where this probe expects it. The probe removes the " +
        "lines it can see; it must be pointed at them again rather than removing a guess.",
    );
  }

  return source.slice(start, end + READ_BACK_TO.length + 1);
};

export const probes = [
  {
    name: "the backfill reports a rejected batch as success — GUARD REMOVED",
    klass: "B",
    harmfulMove:
      "printing the document count off an enqueued task uid, so a batch Meilisearch threw away is " +
      "reported to the operator as a completed backfill",
    files: [BACKFILL],
    appliedMarkers: ["// probe: the batch outcome is not awaited"],
    mutate: () => {
      // Removing the await is the defect. The read-back below it is the second net, and it has to
      // go too: leaving it in place would refuse the run for a different reason, and a probe that
      // goes red for the wrong reason is not evidence about this one.
      substituteOnce(
        BACKFILL,
        `  await waitForTask(client, task.taskUid, \`upserted \${documents.length} document(s)\`);\n`,
        "  // probe: the batch outcome is not awaited\n",
      );

      substituteOnce(BACKFILL, readBackBlock(), CLAIM_WITHOUT_MEASURING);
    },
    detect: async () => {
      const run = await backfillAgainstARefusingIndex();

      const reportedSuccess = run.status === 0 && run.claimedSuccess;
      const batchWasRejected = run.documentsIndexed === 0;

      if (reportedSuccess && !batchWasRejected) {
        throw new Error(
          `the backfill reported success and the index holds ${run.documentsIndexed} document(s), ` +
            "so the batch was NOT rejected and this run measured nothing. Output:\n" +
            run.output.slice(-800),
        );
      }

      return {
        refused: reportedSuccess && batchWasRejected,
        evidence:
          `exit ${run.status}, ` +
          (run.claimedSuccess ? "printed the success line" : "printed no success line") +
          `, index holds ${run.documentsIndexed} document(s) — ` +
          (reportedSuccess && batchWasRejected
            ? "the operator is told a backfill completed over an index Meilisearch refused to write"
            : "the run refused anyway, so the outcome check is not what was holding"),
      };
    },
  },
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await proveTheCommittedPathIsRed();
  await runProbes(probes);
}
