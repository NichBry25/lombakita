/**
 * What the infrastructure queue is actually scheduled to run, read from the queue itself.
 *
 *   npm run queue:schedules
 *
 * WHY THIS EXISTS. The ROADMAP's beta entry condition asks for the payment-expiry job "confirmed
 * registered on the production worker, read from the queue's own schedule list rather than a deploy
 * log", and until now there was no way to read that list: a deploy log says the registration was
 * ATTEMPTED, which is a different claim from the schedule existing. Registration failures are
 * swallowed by design — the worker runtime catches each one so a failed schedule cannot take the
 * worker down — so a log is exactly the instrument that cannot answer this.
 *
 * It reads and prints. It enqueues nothing, removes nothing and writes nothing, so it is safe to
 * run against production.
 *
 * It prints the Redis HOST, never the URL: a Redis URL carries the password in its userinfo, and
 * this output is meant to be pasted into a report.
 */
import { pathToFileURL } from "node:url";

import type { JobSchedulerJson } from "bullmq";

import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/scripts/queue-schedules");

import { ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import { closeAsyncQueueConnections, getAsyncQueue } from "@/server/async/queue";
import { requireRedisUrl } from "@/server/redis/client";

/**
 * One scheduler, as one line.
 *
 * `id` falls back to the scheduler's KEY when BullMQ reports none. A registration path always sets
 * a fixed id, so the fallback should never appear in practice — but a line reading `id=undefined`
 * is a line that cannot be acted on, and the key is the identifier BullMQ itself uses.
 *
 * A field the scheduler does not carry prints `-` rather than being omitted, so two runs against
 * different schedules are read down the same column and a missing field cannot pass for a field
 * that was never printed.
 */
export const describeScheduler = (scheduler: JobSchedulerJson): string => {
  const id = scheduler.id ? scheduler.id : `${scheduler.key} (key)`;
  const pattern = scheduler.pattern ?? "-";
  const tz = scheduler.tz ?? "-";
  const next = typeof scheduler.next === "number" ? new Date(scheduler.next).toISOString() : "-";

  return `id=${id} pattern=${pattern} tz=${tz} next=${next}`;
};

/** The connection's host and port, which is everything about the URL that is not a credential. */
export const describeRedisHost = (url: string): string => `redis host=${new URL(url).host}`;

export const runQueueSchedules = async (): Promise<void> => {
  console.log(describeRedisHost(requireRedisUrl()));

  try {
    const queue = getAsyncQueue(ASYNC_QUEUE_NAMES.infrastructure);
    const schedulers = await queue.getJobSchedulers();

    if (schedulers.length === 0) {
      // Said out loud rather than printed as nothing. An empty list and a command that produced no
      // output at all look identical in a report, and only one of them is a finding.
      console.log("no job schedulers are registered on the infrastructure queue");
      return;
    }

    for (const scheduler of schedulers) {
      console.log(describeScheduler(scheduler));
    }
  } finally {
    await closeAsyncQueueConnections();
  }
};

// Runs on load, because this file IS the command: `npm run queue:schedules` executes it as the entry
// module and nothing else imports it, which is what keeps the exported helpers above importable from
// a test without the runner opening a connection to anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runQueueSchedules()
    .catch((error: unknown) => {
      console.error(
        `\nReading the queue's schedules failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
    })
    // Redis holds open sockets, so the event loop never drains and the process would hang after
    // reporting. Exiting explicitly is what makes this usable as an operator command.
    .finally(() => {
      process.exit(process.exitCode ?? 0);
    });
}
