import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

const loadEnvFiles = (): void => {
  const candidates = [".env.local", ".env"];

  for (const file of candidates) {
    if (!existsSync(file)) {
      continue;
    }

    process.loadEnvFile(file);
  }
};

loadEnvFiles();

const connectionUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionUrl) {
  throw new Error(
    "Drizzle requires DATABASE_URL or MIGRATION_DATABASE_URL. Configure one before running db:generate or db:migrate.",
  );
}

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionUrl,
  },
  strict: true,
  verbose: true,
});
