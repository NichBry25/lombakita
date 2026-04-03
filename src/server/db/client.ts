import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/db/client");

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverEnv } from "@/config/env.server";
import * as schema from "@/server/db/schema";

export type Database = PostgresJsDatabase<typeof schema>;

declare global {
  var __lombakitaSql: postgres.Sql | undefined;
  var __lombakitaDb: Database | undefined;
}

const requireDatabaseUrl = (): string => {
  if (!serverEnv.databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  return serverEnv.databaseUrl;
};

const createSqlClient = (): postgres.Sql => {
  return postgres(requireDatabaseUrl(), {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
};

export const getSqlClient = (): postgres.Sql => {
  if (!globalThis.__lombakitaSql) {
    globalThis.__lombakitaSql = createSqlClient();
  }

  return globalThis.__lombakitaSql;
};

export const getDb = (): Database => {
  if (!globalThis.__lombakitaDb) {
    globalThis.__lombakitaDb = drizzle(getSqlClient(), { schema });
  }

  return globalThis.__lombakitaDb;
};

export const closeDbConnection = async (): Promise<void> => {
  if (globalThis.__lombakitaSql) {
    await globalThis.__lombakitaSql.end({ timeout: 5 });
    globalThis.__lombakitaSql = undefined;
    globalThis.__lombakitaDb = undefined;
  }
};
