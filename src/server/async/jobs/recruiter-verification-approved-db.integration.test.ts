// @vitest-environment node

import { afterAll, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import { competitions, institutions, users } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";

const rollbackState = vi.hoisted(() => ({
  transaction: null as Database | null,
}));

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    getDb: () => {
      if (rollbackState.transaction) return rollbackState.transaction;
      throw new Error("no rollback transaction is open");
    },
  };
});

const { mockSendApproved } = vi.hoisted(() => ({
  mockSendApproved: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/notifications/notification-email", () => ({
  sendRecruiterVerificationApprovedEmail: mockSendApproved,
}));

import {
  processRecruiterVerificationApprovedJob,
  type RecruiterVerificationApprovedJob,
} from "./recruiter-verification-approved";

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
      rollbackState.transaction = tx as unknown as Database;
      try {
        await body(tx);
      } finally {
        rollbackState.transaction = null;
      }
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

const VERIFIED_AT = new Date("2026-01-01T00:00:00Z");

const seedHost = async (tx: Tx, email: string, username: string): Promise<string> => {
  const [row] = await tx
    .insert(users)
    .values({
      email,
      username,
      role: "recruiter",
      emailVerified: VERIFIED_AT,
      candidateVerifiedAt: VERIFIED_AT,
      recruiterVerifiedAt: VERIFIED_AT,
      recruiterVerificationTier: "minimal",
    })
    .returning({ id: users.id });
  return row!.id;
};

describe.skipIf(skipWithoutDatabase)(
  "the newest draft an approval notice links to (real database)",
  () => {
    it("links the host's own newest live draft and nothing else", async () => {
      await inRollback(async (tx) => {
        const hostU = await seedHost(tx, "host.u@example.com", "host_u");
        const hostV = await seedHost(tx, "host.v@example.com", "host_v");

        const [institution] = await tx
          .insert(institutions)
          .values({
            slug: "seed-approval-inst",
            displayName: "Seed Approval Inst",
            institutionType: "company",
          })
          .returning({ id: institutions.id });
        const institutionId = institution!.id;

        await tx.insert(competitions).values([
          {
            institutionId,
            createdByUserId: hostU,
            status: "draft",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            title: "Draf Lama",
            slug: "draf-lama",
          },
          {
            institutionId,
            createdByUserId: hostU,
            status: "draft",
            createdAt: new Date("2026-01-02T00:00:00Z"),
            title: "Draf Baru",
            slug: "draf-baru",
          },
          {
            institutionId,
            createdByUserId: hostU,
            status: "draft",
            createdAt: new Date("2026-01-03T00:00:00Z"),
            deletedAt: new Date("2026-01-04T00:00:00Z"),
            title: "Draf Terhapus",
            slug: "draf-terhapus",
          },
          {
            institutionId,
            createdByUserId: hostU,
            status: "published",
            createdAt: new Date("2026-01-05T00:00:00Z"),
            title: "Lomba Terbit",
            slug: "lomba-terbit",
          },
          {
            institutionId,
            createdByUserId: hostV,
            status: "draft",
            createdAt: new Date("2026-01-06T00:00:00Z"),
            title: "Draf Orang Lain",
            slug: "draf-orang-lain",
          },
        ]);

        await processRecruiterVerificationApprovedJob({
          id: "job-1",
          data: { userId: hostU, epoch: 1 },
        } as unknown as RecruiterVerificationApprovedJob);

        expect(mockSendApproved).toHaveBeenCalledOnce();
        expect(mockSendApproved).toHaveBeenCalledWith(
          expect.objectContaining({
            draft: {
              title: "Draf Baru",
              path: "/institution/seed-approval-inst/competitions/draf-baru",
            },
          }),
        );
      });
    });
  },
);
