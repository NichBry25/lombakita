// @vitest-environment node

import type { Session } from "next-auth";
import { NextRequest } from "next/server";
import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const state = vi.hoisted(() => ({
  db: null as Database | null,
  token: {} as Record<string, unknown>,
}));
vi.mock("@/server/db/client", () => ({
  getDb: () => {
    if (!state.db) throw new Error("No test transaction staged");
    return state.db;
  },
}));
vi.mock("@auth/drizzle-adapter", () => ({ DrizzleAdapter: vi.fn(() => ({})) }));
// Disable adapter initialization only; the real session callback still reads the real rows.
vi.mock("@/config/env.server", () => ({ assertRuntimeEnv: vi.fn(), serverEnv: {} }));
vi.mock("next-auth", () => ({
  getServerSession: async (options: {
    callbacks: {
      jwt: (args: unknown) => Promise<Record<string, unknown>>;
      session: (args: unknown) => Promise<Session>;
    };
  }) => {
    const token = await options.callbacks.jwt({ token: { ...state.token } });
    return options.callbacks.session({ session: { user: {}, expires: "2099-01-01" }, token });
  },
}));
vi.mock("@/server/redis/rate-limit", () => ({
  clearFailedAttempts: vi.fn(),
  isFailedAttemptLimited: vi.fn(),
  recordFailedAttempt: vi.fn(),
  checkFixedWindowLimitFailClosed: async () => ({ decision: "allowed" }),
}));

import { requireAuthenticatedSession, requireSessionRole } from "./session";
import { withMfaRouteAuth } from "./mfa/mfa-route-guard";
import { GET } from "@/app/api/v1/competitions/[competitionId]/route";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;
afterAll(async () => {
  await client?.end();
});
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const inRollback = async (test: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("No test database");
  try {
    await db.transaction(async (tx) => {
      state.db = tx as unknown as Database;
      try {
        await test(tx);
      } finally {
        state.db = null;
      }
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

describe.skipIf(skipWithoutDatabase)(
  "MFA default from persisted account to competition request",
  () => {
    const cases = ["platform_ops", "finance_ops"] as const;
    for (const role of cases) {
      it.each(["enrolment_required", "challenge_required"] as const)(
        `${role} with %s is refused before cross-institution competition data`,
        async (status) =>
          inRollback(async (tx) => {
            const suffix = crypto.randomUUID();
            const [account] = await tx
              .insert(schema.users)
              .values({
                email: `${suffix}@example.test`,
                username: `mfa-${suffix}`,
                role,
                candidateVerifiedAt: new Date(),
              })
              .returning({ id: schema.users.id });
            if (!account) throw new Error("Account fixture was not inserted");
            if (status === "challenge_required")
              await tx.insert(schema.mfaFactors).values({
                userId: account.id,
                encryptedSecret: "unused-test-ciphertext",
                secretIv: "unused-test-iv",
                secretAuthTag: "unused-test-tag",
                verifiedAt: new Date(),
              });
            state.token = { sub: account.id, role, verifiedRoles: [] };
            await expect(requireAuthenticatedSession()).rejects.toMatchObject({
              status: 403,
              code: `mfa_${status}`,
            });
            await expect(requireSessionRole(["candidate"])).rejects.toMatchObject({
              status: 403,
              code: "forbidden",
            });
            const handler = vi.fn(() => new Response(null, { status: 204 }));
            const request = new NextRequest("http://localhost/api/v1/competitions/missing");
            expect((await withMfaRouteAuth(handler)(request)).status).toBe(204);
            expect(handler).toHaveBeenCalledOnce();
            const response = await GET(request, {
              params: Promise.resolve({ competitionId: "missing" }),
            });
            expect(response.status).toBe(403);
            await expect(response.json()).resolves.toMatchObject({
              error: { code: `mfa_${status}` },
            });
          }),
      );
    }
  },
);
