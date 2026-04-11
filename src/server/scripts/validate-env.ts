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

const run = async (): Promise<void> => {
  loadLocalEnvFiles();

  const { assertRuntimeEnv, getRuntimeEnvValidation, resolveServerRuntime } =
    await import("@/config/env.server");

  const argRuntime = process.argv.find((item) => item.startsWith("--runtime="));
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
