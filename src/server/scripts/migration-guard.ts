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

  const { serverEnv } = await import("@/config/env.server");

  if (!serverEnv.migrationDatabaseUrl && !serverEnv.databaseUrl) {
    throw new Error(
      "DATABASE_URL or MIGRATION_DATABASE_URL must be configured before running migrations",
    );
  }

  if (serverEnv.appEnv !== "production") {
    return;
  }

  if (process.env.CONFIRM_PROD_MIGRATION !== "YES_I_UNDERSTAND") {
    throw new Error(
      "Production migration blocked. Set CONFIRM_PROD_MIGRATION=YES_I_UNDERSTAND to continue.",
    );
  }
};

run().catch((error) => {
  console.error("Migration guard failed", error);
  process.exitCode = 1;
});
