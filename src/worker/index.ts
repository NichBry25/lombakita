import { existsSync } from "node:fs";

const loadWorkerEnvFiles = (): void => {
  const candidates = [".env.worker.local", ".env.worker", ".env.local", ".env"];

  for (const file of candidates) {
    if (!existsSync(file)) {
      continue;
    }

    process.loadEnvFile(file);
  }
};

const run = async (): Promise<void> => {
  loadWorkerEnvFiles();

  const { runWorkerBootstrap } = await import("@/worker/bootstrap");

  await runWorkerBootstrap();
};

run().catch((error) => {
  console.error("Worker bootstrap failed", error);
  process.exitCode = 1;
});
