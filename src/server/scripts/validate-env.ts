import { existsSync } from "node:fs";

const loadLocalEnvFiles = (runtimeArg: string | undefined): void => {
  const runtime = runtimeArg?.toLowerCase();
  const candidates =
    runtime === "worker"
      ? [".env.worker.local", ".env.worker", ".env.local", ".env"]
      : [".env.local", ".env"];

  for (const file of candidates) {
    if (!existsSync(file)) {
      continue;
    }

    process.loadEnvFile(file);
  }
};

const run = async (): Promise<void> => {
  const argRuntime = process.argv.find((item) => item.startsWith("--runtime="));
  loadLocalEnvFiles(argRuntime?.split("=")[1]);

  const { assertRuntimeEnv, getRuntimeEnvValidation, resolveServerRuntime } =
    await import("@/config/env.server");

  const runtime = resolveServerRuntime(argRuntime?.split("=")[1]);
  const validation = getRuntimeEnvValidation(runtime);

  console.log(
    JSON.stringify(
      {
        runtime: validation.runtime,
        appEnv: validation.appEnv,
        requiredKeys: validation.requiredKeys,
        missingKeys: validation.missingKeys,
      },
      null,
      2,
    ),
  );

  assertRuntimeEnv(runtime);
};

run().catch((error) => {
  console.error("Environment validation failed", error);
  process.exitCode = 1;
});
