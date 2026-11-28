// @vitest-environment node

// The create route against real rows in a rolled-back transaction: the real tier read, the real
// create service and its refusal of a host whose trust staff removed. Accounts come through the real
// sign-up, code verification and host step services, and the trust removal through the real removal
// service. The operator is planted, and its helper says why.

import { TransactionRollbackError, and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
}));

// The route reads the pooled connection and the session cookie, and this process has neither. Both
// are staged per request and reset in a finally block.
const routeState = vi.hoisted(() => ({
  transaction: null as Database | null,
  actorUserId: null as string | null,
}));

const hostKeys = vi.hoisted(() => ({ one: Buffer.alloc(32, 11).toString("base64") }));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: {
      ...actual.serverEnv,
      authSecret: "test-registration-code-secret",
      hostIdentityHashKey: hostKeys.one,
    },
  };
});

vi.mock("@/server/auth/email-verification", () => ({
  sendRegistrationVerificationEmail: async (options: { email: string; code: string }) => {
    mocks.sentCodes.push({ email: options.email, code: options.code });
  },
  sendOrganizationEmailCode: async () => undefined,
}));

vi.mock("@/server/redis/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/redis/rate-limit")>();
  return {
    ...actual,
    checkFixedWindowLimitFailClosed: async (params: {
      key: string;
      limit: number;
      windowSeconds: number;
    }) => {
      const count = (mocks.windowCounts.get(params.key) ?? 0) + 1;
      mocks.windowCounts.set(params.key, count);
      if (count > params.limit) {
        return { decision: "throttled" as const, retryAfterSeconds: params.windowSeconds };
      }
      return { decision: "allowed" as const };
    },
  };
});

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return { ...actual, getDb: () => routeState.transaction ?? actual.getDb() };
});

vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireSessionRole: async () => {
    if (!routeState.actorUserId) throw new Error("the create route ran with no session staged");
    return {
      user: {
        id: routeState.actorUserId,
        role: "recruiter",
        verifiedRoles: ["candidate", "recruiter"],
      },
    } as unknown as AuthenticatedSession;
  },
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  return {
    ...actual,
    enqueueHostTrustRemoved: vi.fn(async () => ({})),
  };
});

import type { AuthenticatedSession } from "@/server/auth/access-core";
import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import { createInstitutionWorkspaceForUser } from "@/server/institution-workspace/institution-service";
import { removeHostTrust } from "@/server/host-trust/host-trust-removal-service";
import { SESSION_USER_HEADER } from "@/lib/session/session-fetch";
import { POST as createRoute } from "@/app/api/v1/institutions/route";

const PASSWORD = "fresh-pass-3";

const CANDIDATE_DETAILS = {
  name: "Rina Pratama",
  signupRole: "candidate",
  fullName: "Rina Pratama",
  phoneNumber: "0812345678",
  occupation: "college_student",
  dateOfBirth: "2000-01-15",
};

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;
afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const inRollback = async (test: (tx: Database) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("No test database");
  try {
    await db.transaction(async (tx) => {
      await test(tx as unknown as Database);
      (tx as Tx).rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

beforeEach(() => {
  mocks.sentCodes.length = 0;
  mocks.windowCounts.clear();
});

const latestCode = (): string => {
  const sent = mocks.sentCodes.at(-1);
  if (!sent) throw new Error("No code was sent");
  return sent.code;
};

const userIdOfAddress = async (tx: Database, address: string): Promise<string> => {
  const [row] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, address));
  if (!row) throw new Error("No user row");
  return row.id;
};

const signUpParticipant = async (tx: Database, address: string): Promise<string> => {
  await registerUserWithCredentials(
    { ...CANDIDATE_DETAILS, email: address, password: PASSWORD },
    tx,
  );
  await verifyEmailCodeAndSetPassword(
    { ...CANDIDATE_DETAILS, email: address, code: latestCode(), password: PASSWORD },
    tx,
  );
  return userIdOfAddress(tx, address);
};

const signUpHost = async (tx: Database, address: string): Promise<string> => {
  const userId = await signUpParticipant(tx, address);
  await markRoleAsVerified(userId, "recruiter", null, tx);
  return userId;
};

const ownedCountOf = async (tx: Database, userId: string): Promise<number> => {
  const rows = await tx
    .select({ id: schema.institutionMemberships.id })
    .from(schema.institutionMemberships)
    .where(
      and(
        eq(schema.institutionMemberships.userId, userId),
        eq(schema.institutionMemberships.membershipRole, "institution_owner"),
        eq(schema.institutionMemberships.status, "active"),
      ),
    );
  return rows.length;
};

const institutionBySlug = async (tx: Database, slug: string) => {
  const [row] = await tx
    .select({
      displayName: schema.institutions.displayName,
      institutionType: schema.institutions.institutionType,
      slug: schema.institutions.slug,
    })
    .from(schema.institutions)
    .where(eq(schema.institutions.slug, slug));
  return row ?? null;
};

// Planted directly: a stand-in for the operator promotion, which this file does not drive.
const plantOperator = async (tx: Database, address: string): Promise<string> => {
  const userId = await signUpParticipant(tx, address);
  await tx.update(schema.users).set({ role: "platform_ops" }).where(eq(schema.users.id, userId));
  return userId;
};

const tierOf = async (tx: Database, userId: string) => {
  const [row] = await tx
    .select({ tier: schema.users.recruiterVerificationTier })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!row) throw new Error("No user row");
  return row.tier;
};

type CreateBody = {
  institution?: { slug: string; institutionType: string };
  error?: { code: string };
};

const postCreate = async (
  tx: Database,
  actorUserId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: CreateBody }> => {
  routeState.transaction = tx;
  routeState.actorUserId = actorUserId;
  try {
    const request = new Request("http://localhost/api/v1/institutions", {
      method: "POST",
      headers: { "content-type": "application/json", [SESSION_USER_HEADER]: actorUserId },
      body: JSON.stringify(body),
    });
    const response = await createRoute(request as NextRequest);
    const parsed = (await response.json()) as CreateBody;
    return { status: response.status, body: parsed };
  } finally {
    routeState.transaction = null;
    routeState.actorUserId = null;
  }
};

describe.skipIf(skipWithoutDatabase)("the create route on real accounts (rolled back)", () => {
  it("creates a workspace for a host through the real tier read", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, "uji.rute@acme.example");

      const created = await postCreate(tx, host, {
        displayName: "Ruang Uji Rute",
        institutionType: "personal",
      });

      expect(created.status).toBe(201);
      expect(created.body.institution?.slug).toBe("ruang-uji-rute");
      expect(created.body.institution?.institutionType).toBe("personal");
      expect(await ownedCountOf(tx, host)).toBe(1);
    });
  });

  it("refuses an account that never took the host step, read from its own row", async () => {
    await inRollback(async (tx) => {
      const participant = await signUpParticipant(tx, "uji.peserta@acme.example");

      const refused = await postCreate(tx, participant, {
        displayName: "Ruang Uji Peserta",
        institutionType: "company",
      });

      expect(refused.status).toBe(403);
      expect(refused.body.error?.code).toBe("recruiter_role_not_verified");
      expect(await ownedCountOf(tx, participant)).toBe(0);
      expect(await institutionBySlug(tx, "ruang-uji-peserta")).toBeNull();
    });
  });

  it("refuses a host whose trust staff removed and keeps its workspace", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, "uji.cabut@acme.example");
      await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Ruang Uji Lama", institutionType: "personal" },
        tx,
      );
      const operator = await plantOperator(tx, "uji.staf@acme.example");
      await removeHostTrust(operator, host, "Kontak palsu di beberapa kompetisi.", tx);

      const refused = await postCreate(tx, host, {
        displayName: "Ruang Uji Cabut",
        institutionType: "personal",
      });

      expect(refused.status).toBe(403);
      expect(refused.body.error?.code).toBe("institution_create_blocked_trust_removed");
      expect(await tierOf(tx, host)).toBe("minimal");
      expect(await ownedCountOf(tx, host)).toBe(1);
      expect(await institutionBySlug(tx, "ruang-uji-cabut")).toBeNull();
      expect(await institutionBySlug(tx, "ruang-uji-lama")).not.toBeNull();
    });
  });
});
