/**
 * One-time backfill: upsert all published competitions into the Meilisearch
 * competitions index using the same document shape as the index contract.
 *
 * Usage: npx tsx scripts/backfill-search-index.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local before importing anything that reads process.env
const envPath = resolve(process.cwd(), ".env.local");
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  // .env.local may not exist in all environments — continue with existing env
}

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { MeiliSearch } from "meilisearch";
import { competitions, institutions } from "../src/server/db/schema";
import {
  COMPETITION_INDEX_NAME,
  type CompetitionIndexDocument,
} from "../src/server/search/competition-index";
import {
  COMPETITION_INDEX_COLUMNS,
  publishedCompetitionsFilter,
  toCompetitionIndexDocument,
} from "../src/server/search/competition-index-documents";
import { waitForTask } from "./lib/competition-index-admin";

const db_url = process.env.DATABASE_URL;
const meili_host = process.env.MEILISEARCH_HOST;
const meili_key = process.env.MEILISEARCH_API_KEY;

if (!db_url) throw new Error("DATABASE_URL is not set");
if (!meili_host) throw new Error("MEILISEARCH_HOST is not set");

const sql = postgres(db_url, { max: 1 });
const db = drizzle(sql);

const client = new MeiliSearch({ host: meili_host, apiKey: meili_key });
const index = client.index<CompetitionIndexDocument>(COMPETITION_INDEX_NAME);

async function main() {
  const rows = await db
    .select(COMPETITION_INDEX_COLUMNS)
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(publishedCompetitionsFilter());

  const documents: CompetitionIndexDocument[] = rows.map(toCompetitionIndexDocument);

  if (documents.length === 0) {
    console.log("No published competitions found — nothing to upsert.");
    return;
  }

  const task = await index.addDocuments(documents, { primaryKey: "id" });

  // THE TASK IS ENQUEUED, NOT DONE. Meilisearch accepts a batch and reports the outcome
  // asynchronously, so the uid this returns says only that the request was received. Without this
  // wait, a batch where every document was rejected prints the same success line as a batch that
  // landed — the script's own output asserts a count it never measured.
  await waitForTask(client, task.taskUid, `upserted ${documents.length} document(s)`);

  // AND "THE TASK SUCCEEDED" IS NOT "THESE DOCUMENTS ARE THERE". A task can succeed having written
  // fewer documents than it was handed, so the files are read back by id and counted.
  //
  // By id rather than by the index's total, because this script only ever ADDS. An index left over
  // from a previous database legitimately holds documents this run did not write, and the total
  // would report that as a failed backfill. Total-count equality is `search:reindex`'s assertion:
  // it empties the index first, which is what makes the comparison meaningful there. See
  // `scripts/reindex-search-index.ts`.
  const written = await index.getDocuments({
    ids: documents.map((document) => document.id),
    fields: ["id"],
    limit: documents.length,
  });

  if (written.results.length !== documents.length) {
    throw new Error(
      `the index returned ${written.results.length} of the ${documents.length} document(s) this ` +
        "run wrote. The batch was accepted and did not land.",
    );
  }

  console.log(`Upserted ${documents.length} document(s) and read them back.`);
}

// The connection is closed in a finally, so a rejected batch tearing the script down cannot also
// leave the pool open and hang the process instead of exiting non-zero.
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
