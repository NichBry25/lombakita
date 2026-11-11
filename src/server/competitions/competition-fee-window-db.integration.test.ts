// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AuthenticatedSession } from "@/server/auth/access-core";
import * as schema from "@/server/db/schema";
import {
  competitions,
  financeFeeDisclosureAcknowledgements,
  institutionMemberships,
  institutions,
  users,
} from "@/server/db/schema";
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

import { PATCH, PUT } from "@/app/api/v1/competitions/[competitionId]/fee/route";

beforeAll(() => {
  routeState.testRunStarted = true;
});

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

type MembershipRole = "institution_owner" | "institution_staff" | "institution_member";

type Pricing = { feeAmount: number | null; feeCurrency: string | null; paymentWindowDays: number };

const PAID: Pricing = { feeAmount: 150_000, feeCurrency: "IDR", paymentWindowDays: 3 };

const FREE: Pricing = { feeAmount: null, feeCurrency: null, paymentWindowDays: 3 };

type Fixture = {
  institutionId: string;
  competitionId: string;
  ownerUserId: string;
};

const seedUser = async (tx: Tx): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `fee_window_${id}@example.test`,
      username: `fee_window_${id}`,
      role: "recruiter",
      candidateVerifiedAt: new Date(),
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    })
    .returning({ id: users.id });
  return row!.id;
};

const seedMember = async (
  tx: Tx,
  institutionId: string,
  membershipRole: MembershipRole,
): Promise<string> => {
  const userId = await seedUser(tx);
  await tx.insert(institutionMemberships).values({
    institutionId,
    userId,
    membershipRole,
    status: "active",
  });
  return userId;
};

const seedCompetition = async (tx: Tx, pricing: Pricing): Promise<Fixture> => {
  const id = uniqueSuffix();

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `fee-window-inst-${id}`,
      institutionType: "company",
      displayName: `Fee Window Fixture ${id}`,
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      verificationStatus: "pending_verification",
    })
    .returning({ id: institutions.id });

  const ownerUserId = await seedMember(tx, institution!.id, "institution_owner");

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `fee-window-comp-${id}`,
      title: `Fee Window Fixture ${id}`,
      description: "",
      mode: "individual",
      status: "draft",
      feeAmount: pricing.feeAmount,
      feeCurrency: pricing.feeCurrency,
      paymentWindowDays: pricing.paymentWindowDays,
    })
    .returning({ id: competitions.id });

  return { institutionId: institution!.id, competitionId: competition!.id, ownerUserId };
};

const sendFeeRequest = async (
  handler: typeof PATCH,
  method: "PATCH" | "PUT",
  tx: Tx,
  actorUserId: string,
  competitionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  routeState.transaction = tx as unknown as Database;
  routeState.actorUserId = actorUserId;

  const request = new Request(`https://lombakita.test/api/v1/competitions/${competitionId}/fee`, {
    method,
    headers: { "content-type": "application/json", "x-expected-user-id": actorUserId },
    body: JSON.stringify(body),
  });
  const response = await handler(request, { params: Promise.resolve({ competitionId }) });
  const responseBody = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: responseBody };
};

const patchWindowViaRoute = (
  tx: Tx,
  actorUserId: string,
  competitionId: string,
  body: Record<string, unknown>,
) => sendFeeRequest(PATCH, "PATCH", tx, actorUserId, competitionId, body);

const putFeeViaRoute = (
  tx: Tx,
  actorUserId: string,
  competitionId: string,
  body: Record<string, unknown>,
) => sendFeeRequest(PUT, "PUT", tx, actorUserId, competitionId, body);

const readStoredPricing = async (tx: Tx, competitionId: string): Promise<Pricing> => {
  const [row] = await tx
    .select({
      feeAmount: competitions.feeAmount,
      feeCurrency: competitions.feeCurrency,
      paymentWindowDays: competitions.paymentWindowDays,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  return row!;
};

const countConsentRows = async (tx: Tx, competitionId: string): Promise<number> => {
  const [row] = await tx
    .select({ total: count() })
    .from(financeFeeDisclosureAcknowledgements)
    .where(eq(financeFeeDisclosureAcknowledgements.competitionId, competitionId));
  return row!.total;
};

describe.skipIf(skipWithoutDatabase)("the payment window change, against a real database", () => {
  beforeEach(() => {
    routeState.transaction = null;
    routeState.actorUserId = null;
  });

  it("lets institution staff move the window of a paid fee and nothing else", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedCompetition(tx, PAID);
      const staffUserId = await seedMember(tx, fixture.institutionId, "institution_staff");
      const consentRowsBefore = await countConsentRows(tx, fixture.competitionId);

      const { status } = await patchWindowViaRoute(tx, staffUserId, fixture.competitionId, {
        paymentWindowDays: 5,
        feeAmount: 1,
      });

      expect(status).toBe(200);
      expect(await readStoredPricing(tx, fixture.competitionId)).toEqual({
        feeAmount: 150_000,
        feeCurrency: "IDR",
        paymentWindowDays: 5,
      });
      expect(await countConsentRows(tx, fixture.competitionId)).toBe(consentRowsBefore);
    });
  });

  it("lets the owner move the window through the same path without a consent row", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedCompetition(tx, PAID);
      const consentRowsBefore = await countConsentRows(tx, fixture.competitionId);

      const { status } = await patchWindowViaRoute(tx, fixture.ownerUserId, fixture.competitionId, {
        paymentWindowDays: 5,
        feeAmount: 1,
      });

      expect(status).toBe(200);
      expect(await readStoredPricing(tx, fixture.competitionId)).toEqual({
        feeAmount: 150_000,
        feeCurrency: "IDR",
        paymentWindowDays: 5,
      });
      expect(await countConsentRows(tx, fixture.competitionId)).toBe(consentRowsBefore);
    });
  });

  it("refuses institution staff on a free competition and writes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedCompetition(tx, FREE);
      const staffUserId = await seedMember(tx, fixture.institutionId, "institution_staff");

      const { status, body } = await patchWindowViaRoute(tx, staffUserId, fixture.competitionId, {
        paymentWindowDays: 5,
      });

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: { code: "competition_fee_not_enabled" } });
      expect(await readStoredPricing(tx, fixture.competitionId)).toEqual(FREE);
    });
  });

  it("refuses the staff of another institution and writes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedCompetition(tx, PAID);
      const otherFixture = await seedCompetition(tx, PAID);
      const otherStaffUserId = await seedMember(
        tx,
        otherFixture.institutionId,
        "institution_staff",
      );

      const { status, body } = await patchWindowViaRoute(
        tx,
        otherStaffUserId,
        fixture.competitionId,
        { paymentWindowDays: 5 },
      );

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: { code: "forbidden" } });
      expect(await readStoredPricing(tx, fixture.competitionId)).toEqual(PAID);
    });
  });

  it("refuses a revoked staff member and writes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedCompetition(tx, PAID);
      const revokedStaffUserId = await seedMember(tx, fixture.institutionId, "institution_staff");
      const revokedMemberships = await tx
        .update(institutionMemberships)
        .set({ status: "revoked" })
        .where(
          and(
            eq(institutionMemberships.institutionId, fixture.institutionId),
            eq(institutionMemberships.userId, revokedStaffUserId),
            eq(institutionMemberships.membershipRole, "institution_staff"),
          ),
        )
        .returning({ id: institutionMemberships.id });
      expect(revokedMemberships).toHaveLength(1);

      const { status, body } = await patchWindowViaRoute(
        tx,
        revokedStaffUserId,
        fixture.competitionId,
        { paymentWindowDays: 5 },
      );

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: { code: "forbidden" } });
      expect(await readStoredPricing(tx, fixture.competitionId)).toEqual(PAID);
    });
  });

  it("refuses an institution member and writes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedCompetition(tx, PAID);
      const memberUserId = await seedMember(tx, fixture.institutionId, "institution_member");

      const { status, body } = await patchWindowViaRoute(tx, memberUserId, fixture.competitionId, {
        paymentWindowDays: 5,
      });

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: { code: "forbidden" } });
      expect(await readStoredPricing(tx, fixture.competitionId)).toEqual(PAID);
    });
  });

  it("refuses a window outside the allowed range and writes nothing", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedCompetition(tx, PAID);
      const staffUserId = await seedMember(tx, fixture.institutionId, "institution_staff");

      const { status, body } = await patchWindowViaRoute(tx, staffUserId, fixture.competitionId, {
        paymentWindowDays: 0,
      });

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: { code: "competition_invalid_value" } });
      expect(await readStoredPricing(tx, fixture.competitionId)).toEqual(PAID);
    });
  });

  it("still refuses institution staff the price", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedCompetition(tx, PAID);
      const staffUserId = await seedMember(tx, fixture.institutionId, "institution_staff");
      const consentRowsBefore = await countConsentRows(tx, fixture.competitionId);

      const { status } = await putFeeViaRoute(tx, staffUserId, fixture.competitionId, {
        feeAmount: 200_000,
        feeCurrency: "IDR",
        feeDisclosureAcknowledged: true,
      });

      expect(status).toBe(403);
      expect((await readStoredPricing(tx, fixture.competitionId)).feeAmount).toBe(150_000);
      expect(await countConsentRows(tx, fixture.competitionId)).toBe(consentRowsBefore);
    });
  });
});
