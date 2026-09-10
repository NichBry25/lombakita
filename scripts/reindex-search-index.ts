/**
 * Rebuilds the Meilisearch competitions index from current database state.
 *
 *   npm run search:reindex
 *
 * THIS IS THE ONE THAT REMOVES. `setup-search-index.ts` provisions the index and `backfill-search-
 * index.ts` upserts into it, and both only ever ADD: after a database reset every document they
 * wrote is still there, pointing at competition rows that no longer exist. Search then returns
 * results whose detail pages 404, which is worse than an empty catalogue because it looks like the
 * platform lost data rather than that the index is stale. Nothing else repopulates the index either
 * — it is written only by the async publish/edit job — so a reset without this step leaves search
 * permanently describing the database that used to be there.
 *
 * Guarded by the same refusal as the reset path (`reset/reset-guard.ts`). Emptying an index is
 * destructive even though it is recoverable, and this deliberately has no production capability.
 * Repairing a production index is `setup-search-index.ts`, which adds without removing.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { MeiliSearch } from "meilisearch";
import postgres from "postgres";

import { loadEnvFile, describeEnvFileLoad } from "@/server/scripts/env-file";
import { competitions, institutions } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import {
  COMPETITION_INDEX_NAME,
  type CompetitionIndexDocument,
} from "@/server/search/competition-index";
import {
  COMPETITION_INDEX_COLUMNS,
  publishedCompetitionsFilter,
  toCompetitionIndexDocument,
} from "@/server/search/competition-index-documents";
import {
  applyCompetitionIndexSettings,
  ensureCompetitionIndexExists,
  waitForTask,
} from "./lib/competition-index-admin";
import {
  ResetRefused,
  assertResetTargetIsDisposable,
  declaredAppEnvironment,
} from "./reset/reset-guard";

const main = async (): Promise<void> => {
  console.log(describeEnvFileLoad(loadEnvFile({})));

  const appEnv = declaredAppEnvironment();
  const databaseUrl = process.env.DATABASE_URL;
  const meilisearchHost = process.env.MEILISEARCH_HOST;
  const meilisearchKey = process.env.MEILISEARCH_API_KEY;

  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!meilisearchHost) throw new Error("MEILISEARCH_HOST is not set");
  if (!meilisearchKey) throw new Error("MEILISEARCH_API_KEY is not set");

  const sql = postgres(databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  const client = new MeiliSearch({ host: meilisearchHost, apiKey: meilisearchKey });
  const index = client.index<CompetitionIndexDocument>(COMPETITION_INDEX_NAME);

  try {
    // Asked of the database this reads from, which is the same one whose contents decide what the
    // index will hold. Refusing here is what makes the index rebuild non-production-capable.
    await assertResetTargetIsDisposable(sql, { appEnv, databaseUrl, redisUrl: null });

    console.log(`\nMeilisearch host: ${meilisearchHost}`);

    console.log("\n[1/4] Ensuring the index exists");
    await ensureCompetitionIndexExists(client);

    console.log("\n[2/4] Applying index settings");
    await applyCompetitionIndexSettings(client);

    // BEFORE the rebuild, so a document whose row was deleted cannot survive it. Upserting over a
    // stale index leaves every removed competition in place — that is the defect this step closes.
    console.log("\n[3/4] Emptying the index");
    const cleared = await index.deleteAllDocuments();
    await waitForTask(client, cleared.taskUid, "index emptied");

    console.log("\n[4/4] Rebuilding from the database");
    const db = drizzle(sql);
    const rows = await db
      .select(COMPETITION_INDEX_COLUMNS)
      .from(competitions)
      .innerJoin(institutions, eq(institutions.id, competitions.institutionId))
      .where(publishedCompetitionsFilter());

    if (rows.length === 0) {
      console.log("  ✓ no published competitions — the index is empty and correctly so");
    } else {
      const documents = rows.map(toCompetitionIndexDocument);
      const upserted = await index.addDocuments(documents, { primaryKey: "id" });
      await waitForTask(client, upserted.taskUid, `rebuilt ${documents.length} document(s)`);
    }

    // The point of the whole script, asserted rather than assumed: what the index holds is what the
    // database holds. A rebuild that enqueued documents Meilisearch then rejected would otherwise
    // print four ticks and leave the index wrong.
    //
    // `getStats().numberOfDocuments` rather than a search's `estimatedTotalHits`, which is
    // ESTIMATED — the name is the specification. It is exact on a small index, so an equality
    // assertion against it passes today and starts failing on a full catalogue, at which point it
    // reads as a broken rebuild rather than as the wrong instrument.
    const { numberOfDocuments } = await index.getStats();

    if (numberOfDocuments !== rows.length) {
      throw new Error(
        `the index holds ${numberOfDocuments} document(s) but the database holds ${rows.length} ` +
          "published competition(s). The rebuild did not land.",
      );
    }

    console.log(
      `\nDone. The index holds ${numberOfDocuments} document(s), matching the database.\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
};

main().catch((error: unknown) => {
  if (error instanceof ResetRefused) {
    console.error(`\nREFUSED [${error.layer}]\n${error.message}\n`);
  } else {
    console.error("\nReindex failed:", error);
  }

  process.exitCode = 1;
});
