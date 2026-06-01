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
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  // .env.local may not exist — continue with env vars already in the environment
}

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, isNull } from "drizzle-orm";
import { MeiliSearch } from "meilisearch";
import { competitions, institutions } from "../src/server/db/schema";
import {
  COMPETITION_INDEX_NAME,
  COMPETITION_INDEX_FILTERABLE_ATTRIBUTES,
  COMPETITION_INDEX_SORTABLE_ATTRIBUTES,
  COMPETITION_INDEX_SEARCHABLE_ATTRIBUTES,
  type CompetitionIndexDocument,
} from "../src/server/search/competition-index";

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

async function waitForTask(taskUid: number, label: string): Promise<void> {
  const task = await client.tasks.waitForTask(taskUid, { timeout: 30_000, interval: 500 });
  if (task.status === "failed") {
    throw new Error(`Task "${label}" failed: ${JSON.stringify(task.error)}`);
  }
  console.log(`  ✓ ${label}`);
}

async function main() {
  // ── 1. Create index (idempotent) ───────────────────────────────────────────
  console.log("\n[1/3] Creating index...");
  const createTask = await client.createIndex(COMPETITION_INDEX_NAME, { primaryKey: "id" });
  const createdResult = await client.tasks.waitForTask(createTask.taskUid, { timeout: 30_000, interval: 500 });
  if (createdResult.status === "failed") {
    if (createdResult.error?.code === "index_already_exists") {
      console.log(`  ✓ index '${COMPETITION_INDEX_NAME}' already exists — skipping`);
    } else {
      throw new Error(`Task "create index" failed: ${JSON.stringify(createdResult.error)}`);
    }
  } else {
    console.log(`  ✓ index '${COMPETITION_INDEX_NAME}' created`);
  }

  const index = client.index<CompetitionIndexDocument>(COMPETITION_INDEX_NAME);

  // ── 2. Configure settings ──────────────────────────────────────────────────
  console.log("\n[2/3] Configuring index settings...");

  const filterTask = await index.updateFilterableAttributes([
    ...COMPETITION_INDEX_FILTERABLE_ATTRIBUTES,
  ]);
  await waitForTask(filterTask.taskUid, `filterable attributes: ${COMPETITION_INDEX_FILTERABLE_ATTRIBUTES.join(", ")}`);

  const sortTask = await index.updateSortableAttributes([
    ...COMPETITION_INDEX_SORTABLE_ATTRIBUTES,
  ]);
  await waitForTask(sortTask.taskUid, `sortable attributes: ${COMPETITION_INDEX_SORTABLE_ATTRIBUTES.join(", ")}`);

  const searchTask = await index.updateSearchableAttributes([
    ...COMPETITION_INDEX_SEARCHABLE_ATTRIBUTES,
  ]);
  await waitForTask(searchTask.taskUid, `searchable attributes: ${COMPETITION_INDEX_SEARCHABLE_ATTRIBUTES.join(", ")}`);

  // ── 3. Backfill documents ──────────────────────────────────────────────────
  console.log("\n[3/3] Backfilling published competitions...");

  const rows = await db
    .select({
      id: competitions.id,
      title: competitions.title,
      slug: competitions.slug,
      category: competitions.category,
      mode: competitions.mode,
      registrationEndAt: competitions.registrationEndAt,
      createdAt: competitions.createdAt,
      isFeatured: competitions.isFeatured,
      featuredOrder: competitions.featuredOrder,
      institutionSlug: institutions.slug,
      institutionName: institutions.displayName,
    })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(and(eq(competitions.status, "published"), isNull(competitions.deletedAt)));

  if (rows.length === 0) {
    console.log("  No published competitions found — index is empty but ready.");
  } else {
    const documents: CompetitionIndexDocument[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      category: r.category ?? null,
      mode: r.mode ?? null,
      deadline: r.registrationEndAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      isFeatured: r.isFeatured,
      featuredOrder: r.featuredOrder ?? null,
      institutionSlug: r.institutionSlug,
      institutionName: r.institutionName,
      status: "published",
    }));

    const upsertTask = await index.addDocuments(documents, { primaryKey: "id" });
    await waitForTask(upsertTask.taskUid, `upserted ${documents.length} document(s)`);
  }

  await sql.end();
  console.log("\nDone. Meilisearch index is ready.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
