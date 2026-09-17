/**
 * One-time setup: create the Meilisearch competitions index, configure filterable/sortable/
 * searchable attributes, and backfill all published competitions from the database.
 *
 * Run against any Meilisearch instance by setting env vars before executing:
 *
 *   # Staging (override .env.local values):
 *   MEILISEARCH_HOST=https://meilisearch-staging-ff7b.up.railway.app \
 *   MEILISEARCH_API_KEY=<key> \
 *   DATABASE_URL=<neon-staging-url> \
 *   ./node_modules/.bin/tsx scripts/setup-search-index.ts
 *
 *   # Local (reads from .env.local automatically):
 *   ./node_modules/.bin/tsx scripts/setup-search-index.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local before anything reads process.env — but only for keys not already set,
// so explicit env var overrides (e.g. for staging) are never clobbered.
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
  // .env.local may not exist — continue with env vars already in the environment
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
import {
  applyCompetitionIndexSettings,
  ensureCompetitionIndexExists,
  waitForTask,
} from "./lib/competition-index-admin";

const db_url = process.env.DATABASE_URL;
const meili_host = process.env.MEILISEARCH_HOST;
const meili_key = process.env.MEILISEARCH_API_KEY;

if (!db_url) throw new Error("DATABASE_URL is not set");
if (!meili_host) throw new Error("MEILISEARCH_HOST is not set");
if (!meili_key) throw new Error("MEILISEARCH_API_KEY is not set");

console.log(`Meilisearch host: ${meili_host}`);

const sql = postgres(db_url, { max: 1 });
const db = drizzle(sql);
const client = new MeiliSearch({ host: meili_host, apiKey: meili_key });

async function main() {
  // ── 1. Create index (idempotent) ───────────────────────────────────────────
  console.log("\n[1/3] Creating index...");
  await ensureCompetitionIndexExists(client);

  const index = client.index<CompetitionIndexDocument>(COMPETITION_INDEX_NAME);

  // ── 2. Configure settings ──────────────────────────────────────────────────
  console.log("\n[2/3] Configuring index settings...");
  await applyCompetitionIndexSettings(client);

  // ── 3. Backfill documents ──────────────────────────────────────────────────
  // UPSERT ONLY, never removing. That is what makes this safe to run against production and what
  // makes it the wrong tool after a database reset — use `npm run search:reindex` for that.
  console.log("\n[3/3] Backfilling published competitions...");

  const rows = await db
    .select(COMPETITION_INDEX_COLUMNS)
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(publishedCompetitionsFilter());

  if (rows.length === 0) {
    console.log("  No published competitions found — index is empty but ready.");
  } else {
    const documents = rows.map(toCompetitionIndexDocument);
    const upsertTask = await index.addDocuments(documents, { primaryKey: "id" });
    await waitForTask(client, upsertTask.taskUid, `upserted ${documents.length} document(s)`);
  }

  await sql.end();
  console.log("\nDone. Meilisearch index is ready.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
