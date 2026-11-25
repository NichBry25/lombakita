// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import { competitions, institutions, notifications, users } from "@/server/db/schema";
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
    afterEach(() => {
      mockSendApproved.mockClear();
    });

    it("links the host's own newest live draft and nothing else", async () => {
      const suffix = randomUUID().slice(0, 8);
      const institutionSlug = `seed-approval-inst-${suffix}`;
      await inRollback(async (tx) => {
        const hostU = await seedHost(tx, `host.u.${suffix}@example.com`, `host_u_${suffix}`);
        const hostV = await seedHost(tx, `host.v.${suffix}@example.com`, `host_v_${suffix}`);

        const [institution] = await tx
          .insert(institutions)
          .values({
            slug: institutionSlug,
            displayName: "Seed Approval Inst",
            institutionType: "company",
          })
          .returning({ id: institutions.id });
        const institutionId = institution!.id;
        // Planted directly: the host runs this institution as its owner.
        await tx.insert(schema.institutionMemberships).values({
          institutionId,
          userId: hostU,
          membershipRole: "institution_owner",
          status: "active",
        });

        await tx.insert(competitions).values([
          {
            institutionId,
            createdByUserId: hostU,
            status: "draft",
            createdAt: new Date("2099-01-01T00:00:00Z"),
            title: "Draf Lama",
            slug: "draf-lama",
          },
          {
            institutionId,
            createdByUserId: hostU,
            status: "draft",
            createdAt: new Date("2099-01-02T00:00:00Z"),
            title: "Draf Baru",
            slug: "draf-baru",
          },
          {
            institutionId,
            createdByUserId: hostU,
            status: "draft",
            createdAt: new Date("2099-01-03T00:00:00Z"),
            deletedAt: new Date("2099-01-04T00:00:00Z"),
            title: "Draf Terhapus",
            slug: "draf-terhapus",
          },
          {
            institutionId,
            createdByUserId: hostU,
            status: "published",
            createdAt: new Date("2099-01-05T00:00:00Z"),
            title: "Lomba Terbit",
            slug: "lomba-terbit",
          },
          {
            institutionId,
            createdByUserId: hostV,
            status: "draft",
            createdAt: new Date("2099-01-06T00:00:00Z"),
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
            path: `/institution/${institutionSlug}/competitions/draf-baru`,
          }),
        );

        const inbox = await tx
          .select({ body: notifications.body })
          .from(notifications)
          .where(eq(notifications.userId, hostU));
        expect(inbox).toEqual([
          {
            body: 'Anda sekarang dapat menerbitkan kompetisi. Buka draf "Draf Baru" lalu tekan Terbitkan.',
          },
        ]);
      });
    });

    it("reads the competition of a host check approval when the job runs", async () => {
      const suffix = randomUUID().slice(0, 8);
      const institutionSlug = `seed-approval-inst-${suffix}`;
      await inRollback(async (tx) => {
        const hostU = await seedHost(tx, `host.u.${suffix}@example.com`, `host_u_${suffix}`);

        const [institution] = await tx
          .insert(institutions)
          .values({
            slug: institutionSlug,
            displayName: "Seed Approval Inst",
            institutionType: "company",
          })
          .returning({ id: institutions.id });
        const institutionId = institution!.id;
        // Planted directly: the host runs this institution as its owner.
        await tx.insert(schema.institutionMemberships).values({
          institutionId,
          userId: hostU,
          membershipRole: "institution_owner",
          status: "active",
        });

        const [published] = await tx
          .insert(competitions)
          .values({
            institutionId,
            createdByUserId: hostU,
            status: "published",
            title: "Lomba Terbit",
            slug: "lomba-terbit",
          })
          .returning({ id: competitions.id });

        await processRecruiterVerificationApprovedJob({
          id: "job-2",
          data: { userId: hostU, competitionId: published!.id, epoch: 2 },
        } as unknown as RecruiterVerificationApprovedJob);

        const inbox = await tx
          .select({ body: notifications.body })
          .from(notifications)
          .where(eq(notifications.userId, hostU));
        expect(inbox).toEqual([
          { body: 'Akun Anda kini tepercaya dan "Lomba Terbit" sudah tayang.' },
        ]);
        expect(mockSendApproved).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Kompetisi Anda lolos pemeriksaan",
            path: `/competitions/${institutionSlug}/lomba-terbit`,
          }),
        );
      });
    });
  },
);
