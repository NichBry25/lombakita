// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import * as schema from "@/server/db/schema";
import { competitions, institutionMemberships, institutions, users } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { NEW_INSTITUTION_DEFAULT_STATUS } from "@/server/institution-workspace/institution-service";

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
      throw new Error("the fee route read the database outside a test");
    },
  };
});

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireAuthenticatedSession: async () => {
    if (!routeState.actorUserId) {
      throw new Error("the fee route ran with no session staged");
    }
    return {
      user: { id: routeState.actorUserId, role: "recruiter" },
    } as unknown as AuthenticatedSession;
  },
}));

import { GET } from "@/app/api/v1/competitions/[competitionId]/fee/route";

beforeAll(() => {
  routeState.testRunStarted = true;
});

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

type ActorRole = "institution_owner" | "institution_staff";

type Fixture = {
  competitionId: string;
  actorUserId: string;
};

const seedUser = async (tx: Tx): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `fee_get_${id}@example.test`,
      username: `fee_get_${id}`,
      role: "recruiter",
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    })
    .returning({ id: users.id });
  return row!.id;
};

const seedFixture = async (tx: Tx, actorRole: ActorRole): Promise<Fixture> => {
  const id = uniqueSuffix();

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `fee-get-inst-${id}`,
      institutionType: "company",
      displayName: `Fee Get Fixture ${id}`,
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      verificationStatus: "pending_verification",
    })
    .returning({ id: institutions.id });

  const actorUserId = await seedUser(tx);
  await tx.insert(institutionMemberships).values({
    institutionId: institution!.id,
    userId: actorUserId,
    membershipRole: actorRole,
    status: "active",
  });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `fee-get-comp-${id}`,
      title: `Fee Get Fixture ${id}`,
      description: "",
      mode: "individual",
      status: "draft",
      feeAmount: 50_000,
      feeCurrency: "IDR",
    })
    .returning({ id: competitions.id });

  return { competitionId: competition!.id, actorUserId };
};

const getFeeViaRoute = async (
  fixture: Fixture,
  tx: Tx,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  routeState.transaction = tx as unknown as Database;
  routeState.actorUserId = fixture.actorUserId;

  const request = new Request(
    `https://lombakita.test/api/v1/competitions/${fixture.competitionId}/fee`,
    { method: "GET" },
  );
  const response = await GET(request, {
    params: Promise.resolve({ competitionId: fixture.competitionId }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
};

describe.skipIf(skipWithoutDatabase)("the fee settings read, against a real database", () => {
  beforeEach(() => {
    routeState.transaction = null;
    routeState.actorUserId = null;
  });

  it("refuses an institution staff member the fee settings", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx, "institution_staff");

      const { status, body } = await getFeeViaRoute(fixture, tx);

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: { code: "forbidden" } });
      expect(body).not.toHaveProperty("pricing");
    });
  });

  it("answers the institution owner with the fee settings", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx, "institution_owner");

      const { status, body } = await getFeeViaRoute(fixture, tx);

      expect(status).toBe(200);
      expect(body).toMatchObject({ pricing: { feeAmount: 50_000 } });
    });
  });
});
