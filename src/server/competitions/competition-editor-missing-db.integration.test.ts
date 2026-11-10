// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import * as schema from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const inRollback = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("no database");
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

const routeState = vi.hoisted(() => ({
  transaction: null as Database | null,
  actorUserId: null as string | null,
  testRunStarted: false,
}));

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    getDb: () => {
      if (routeState.transaction) return routeState.transaction;
      if (!routeState.testRunStarted) return actual.getDb();
      throw new Error("an editor route read the database outside a test");
    },
  };
});

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireAuthenticatedSession: async () => {
    if (!routeState.actorUserId) {
      throw new Error("an editor route ran with no session staged");
    }
    return {
      user: { id: routeState.actorUserId, role: "recruiter" },
    } as unknown as AuthenticatedSession;
  },
}));

import * as eligibilityRoute from "@/app/api/v1/competitions/[competitionId]/eligibility/route";
import * as prizesRoute from "@/app/api/v1/competitions/[competitionId]/prizes/route";
import * as roundsRoute from "@/app/api/v1/competitions/[competitionId]/rounds/route";
import * as tagsRoute from "@/app/api/v1/competitions/[competitionId]/tags/route";

beforeAll(() => {
  routeState.testRunStarted = true;
});

const EDITOR_ROUTES = [
  { name: "tags", route: tagsRoute },
  { name: "prizes", route: prizesRoute },
  { name: "eligibility", route: eligibilityRoute },
  { name: "rounds", route: roundsRoute },
];

describe.skipIf(skipWithoutDatabase)(
  "the competition editor routes, against a real database",
  () => {
    beforeEach(() => {
      routeState.transaction = null;
      routeState.actorUserId = null;
    });

    it.each(EDITOR_ROUTES)(
      "answers a missing competition with not found on the $name GET",
      async ({ name, route }) => {
        await inRollback(async (tx) => {
          const competitionId = `missing-competition-${Date.now()}`;
          routeState.transaction = tx as unknown as Database;
          routeState.actorUserId = "missing-competition-actor";

          const response = await route.GET(
            new Request(`https://lombakita.test/api/v1/competitions/${competitionId}/${name}`, {
              method: "GET",
            }),
            { params: Promise.resolve({ competitionId }) },
          );

          expect(response.status).toBe(404);
          expect(await response.json()).toMatchObject({ error: { code: "competition_not_found" } });
        });
      },
    );

    it.each(EDITOR_ROUTES)(
      "answers a missing competition with not found on the $name PUT",
      async ({ name, route }) => {
        await inRollback(async (tx) => {
          const competitionId = `missing-competition-${Date.now()}`;
          routeState.transaction = tx as unknown as Database;
          routeState.actorUserId = "missing-competition-actor";

          const response = await route.PUT(
            new Request(`https://lombakita.test/api/v1/competitions/${competitionId}/${name}`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                "X-Expected-User-Id": "missing-competition-actor",
              },
              body: "{}",
            }),
            { params: Promise.resolve({ competitionId }) },
          );

          expect(response.status).toBe(404);
          expect(await response.json()).toMatchObject({ error: { code: "competition_not_found" } });
        });
      },
    );
  },
);
