import { vi } from "vitest";
import { users } from "@/server/db/schema";
import type { Database } from "@/server/db/client";

export const createEnrolmentTestDatabase = (account: {
  email: string;
  username: string;
  role: string | undefined;
  status: string;
  suspendedAt: Date | null;
}) => {
  const factorRows: unknown[] = [];
  const insert = vi.fn(() => ({
    values: vi.fn(async (row: unknown) => {
      factorRows.push(row);
    }),
  }));
  const update = vi.fn();
  const select = vi.fn(() => {
    let rows: unknown[] = [];
    const query = {
      from: (table: unknown) => {
        rows = table === users ? [account] : factorRows;
        return query;
      },
      where: () => query,
      limit: () => ({
        then: (resolve: (value: unknown[]) => void) => resolve(rows),
        for: async () => rows,
      }),
    };
    return query;
  });
  const tx = { select, insert, update };
  const transaction = vi.fn(async (body: (database: unknown) => Promise<unknown>) => body(tx));
  return { database: { transaction } as unknown as Database, factorRows, insert, update };
};
