import { existsSync } from "node:fs";

const loadLocalEnvFiles = (): void => {
  const candidates = [".env.local", ".env"];

  for (const file of candidates) {
    if (!existsSync(file)) {
      continue;
    }

    process.loadEnvFile(file);
  }
};

const getArgValue = (name: string): string | undefined => {
  const directPrefix = `--${name}=`;
  const direct = process.argv.find((entry) => entry.startsWith(directPrefix));

  if (direct) {
    return direct.slice(directPrefix.length);
  }

  const index = process.argv.findIndex((entry) => entry === `--${name}`);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
};

const run = async (): Promise<void> => {
  loadLocalEnvFiles();

  const probeId = getArgValue("probe-id") ?? `probe-${Date.now()}`;
  const { assertRuntimeEnv, resolveServerRuntime } = await import("@/config/env.server");
  const runtime = resolveServerRuntime(process.env.RUNTIME_NAME);
  assertRuntimeEnv(runtime);

  const { enqueueProbeJob } = await import("@/server/async/enqueue");
  const { closeAsyncQueueConnections } = await import("@/server/async/queue");

  try {
    const result = await enqueueProbeJob({
      probeId,
      triggeredBy: "script",
    });

    console.log(
      JSON.stringify(
        {
          status: "accepted",
          runtime,
          probeId,
          queueName: result.queueName,
          jobName: result.jobName,
          jobId: result.jobId,
          idempotencyKey: result.idempotencyKey,
          duplicate: result.duplicate,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeAsyncQueueConnections();
  }
};

run().catch((error) => {
  console.error("Probe enqueue failed", error);
  process.exitCode = 1;
});
