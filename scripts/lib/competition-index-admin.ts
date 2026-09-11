/**
 * Creating and configuring the Meilisearch competitions index, in one place.
 *
 * Provisioning it and rebuilding it are two operations that must leave the index in the SAME state.
 * Written out twice they drift, and the way that surfaces is not an error: it is a filter that
 * silently matches nothing, or a sort that silently does not sort, on whichever path last touched
 * the index. Both callers apply the attribute sets declared in `competition-index.ts`.
 */

import type { MeiliSearch } from "meilisearch";
import {
  COMPETITION_INDEX_NAME,
  COMPETITION_INDEX_FILTERABLE_ATTRIBUTES,
  COMPETITION_INDEX_SORTABLE_ATTRIBUTES,
  COMPETITION_INDEX_SEARCHABLE_ATTRIBUTES,
} from "@/server/search/competition-index";

const TASK_TIMEOUT_MS = 30_000;
const TASK_POLL_INTERVAL_MS = 500;

/**
 * Waits for one Meilisearch task and THROWS IF IT FAILED.
 *
 * Meilisearch accepts a task and reports failure asynchronously, so an unwaited `addDocuments`
 * returns a task id and nothing else — a rebuild that enqueued every document and had every one of
 * them rejected looks identical to one that worked.
 */
export const waitForTask = async (
  client: MeiliSearch,
  taskUid: number,
  label: string,
): Promise<void> => {
  const task = await client.tasks.waitForTask(taskUid, {
    timeout: TASK_TIMEOUT_MS,
    interval: TASK_POLL_INTERVAL_MS,
  });

  if (task.status === "failed") {
    throw new Error(`Task "${label}" failed: ${JSON.stringify(task.error)}`);
  }

  console.log(`  ✓ ${label}`);
};

/** Creates the index if it is absent, tolerating the case where it already exists. */
export const ensureCompetitionIndexExists = async (client: MeiliSearch): Promise<void> => {
  const created = await client.createIndex(COMPETITION_INDEX_NAME, { primaryKey: "id" });
  const result = await client.tasks.waitForTask(created.taskUid, {
    timeout: TASK_TIMEOUT_MS,
    interval: TASK_POLL_INTERVAL_MS,
  });

  if (result.status !== "failed") {
    console.log(`  ✓ index '${COMPETITION_INDEX_NAME}' created`);
    return;
  }

  if (result.error?.code === "index_already_exists") {
    console.log(`  ✓ index '${COMPETITION_INDEX_NAME}' already exists — skipping`);
    return;
  }

  throw new Error(`Task "create index" failed: ${JSON.stringify(result.error)}`);
};

/** Applies the filterable, sortable and searchable attribute sets the index contract declares. */
export const applyCompetitionIndexSettings = async (client: MeiliSearch): Promise<void> => {
  const index = client.index(COMPETITION_INDEX_NAME);

  const filterable = await index.updateFilterableAttributes([
    ...COMPETITION_INDEX_FILTERABLE_ATTRIBUTES,
  ]);
  await waitForTask(
    client,
    filterable.taskUid,
    `filterable attributes: ${COMPETITION_INDEX_FILTERABLE_ATTRIBUTES.join(", ")}`,
  );

  const sortable = await index.updateSortableAttributes([...COMPETITION_INDEX_SORTABLE_ATTRIBUTES]);
  await waitForTask(
    client,
    sortable.taskUid,
    `sortable attributes: ${COMPETITION_INDEX_SORTABLE_ATTRIBUTES.join(", ")}`,
  );

  const searchable = await index.updateSearchableAttributes([
    ...COMPETITION_INDEX_SEARCHABLE_ATTRIBUTES,
  ]);
  await waitForTask(
    client,
    searchable.taskUid,
    `searchable attributes: ${COMPETITION_INDEX_SEARCHABLE_ATTRIBUTES.join(", ")}`,
  );
};
