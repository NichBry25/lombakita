import { getSqlClient } from "@/server/db/client";

export const isDatabaseConfigured = (): boolean => {
  return Boolean(process.env.DATABASE_URL);
};

export const probeDatabase = async (): Promise<void> => {
  const sql = getSqlClient();
  await sql`select 1`;
};
