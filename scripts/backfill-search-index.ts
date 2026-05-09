/**
 * One-time backfill: upsert all published competitions into the Meilisearch
 * competitions index using the same document shape as the Step 3.4 index contract.
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
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  // .env.local may not exist in all environments — continue with existing env
}

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, isNull } from "drizzle-orm";
import { MeiliSearch } from "meilisearch";
import { competitions, institutions } from "../src/server/db/schema";
import {
  COMPETITION_INDEX_NAME,
  type CompetitionIndexDocument,
} from "../src/server/search/competition-index";

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
    .select({
      id: competitions.id,
      title: competitions.title,
      slug: competitions.slug,
      category: competitions.category,
      mode: competitions.mode,
      registrationEndAt: competitions.registrationEndAt,
      createdAt: competitions.createdAt,
      institutionSlug: institutions.slug,
      institutionName: institutions.displayName,
    })
    .from(competitions)
    .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
    .where(and(eq(competitions.status, "published"), isNull(competitions.deletedAt)));

  const documents: CompetitionIndexDocument[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    slug: r.slug,
    category: r.category ?? null,
    mode: r.mode ?? null,
    deadline: r.registrationEndAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    institutionSlug: r.institutionSlug,
    institutionName: r.institutionName,
    status: "published",
  }));

  if (documents.length === 0) {
    console.log("No published competitions found — nothing to upsert.");
  } else {
    const task = await index.addDocuments(documents, { primaryKey: "id" });
    console.log(`Upserted ${documents.length} document(s). Meilisearch task uid: ${task.taskUid}`);
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
