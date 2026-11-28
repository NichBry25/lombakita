// @vitest-environment node

// Workspace creation for every kind and the per-owner cap, against real rows in a rolled-back
// transaction. Accounts come through the real sign-up, code verification and host step services,
// usernames through the real profile service, and workspaces through the real creation and settings
// services. A row is planted directly only where no production path writes it any more, and each
// such helper says so.

import { TransactionRollbackError, and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import type { Database } from "@/server/db/client";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";

const mocks = vi.hoisted(() => ({
  sentCodes: [] as Array<{ email: string; code: string }>,
  windowCounts: new Map<string, number>(),
}));

vi.mock("@/config/env.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/env.server")>();
  return {
    ...actual,
    serverEnv: { ...actual.serverEnv, authSecret: "test-registration-code-secret" },
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

import {
  registerUserWithCredentials,
  verifyEmailCodeAndSetPassword,
} from "@/server/auth/credentials-auth";
import { markRoleAsVerified } from "@/server/auth/role-verification";
import {
  NEW_INSTITUTION_DEFAULT_STATUS,
  createInstitutionWorkspaceForUser,
  updateInstitutionWorkspaceForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";
import { updateOwnerProfile } from "@/server/user-profile/profile-service";

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

const setUsername = async (tx: Database, userId: string, username: string): Promise<void> => {
  await updateOwnerProfile(userId, { username }, tx);
};

// Planted directly: the service no longer lets an owner hold a workspace above the cap, so the old
// allowance of three full workspaces and one personal one is written as a direct insert.
const plantPersonalWorkspace = async (
  tx: Database,
  ownerId: string,
  slug: string,
): Promise<void> => {
  const [institution] = await tx
    .insert(schema.institutions)
    .values({
      displayName: "Ruang Uji Lama",
      slug,
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      institutionType: "personal",
    })
    .returning({ id: schema.institutions.id });
  if (!institution) throw new Error("No institution row planted");

  await tx.insert(schema.institutionMemberships).values({
    institutionId: institution.id,
    userId: ownerId,
    membershipRole: "institution_owner",
    status: "active",
  });
};

describe.skipIf(skipWithoutDatabase)("workspace creation for every kind (rolled back)", () => {
  it("creates a personal workspace with a typed name and a slug from that name", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, "uji.satu@acme.example");

      const shell = await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Ruang Uji Pribadi", institutionType: "personal" },
        tx,
      );

      expect(shell.institutionType).toBe("personal");
      expect(shell.displayName).toBe("Ruang Uji Pribadi");
      expect(shell.slug).toBe("ruang-uji-pribadi");
      expect(shell.ownerMembership.membershipRole).toBe("institution_owner");
      expect(shell.ownerMembership.membershipStatus).toBe("active");
      expect(await institutionBySlug(tx, "ruang-uji-pribadi")).toEqual({
        displayName: "Ruang Uji Pribadi",
        institutionType: "personal",
        slug: "ruang-uji-pribadi",
      });
      expect(await ownedCountOf(tx, host)).toBe(1);
    });
  });

  it("counts every kind against the cap of 3", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, "uji.dua@acme.example");
      await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Ruang Uji Satu", institutionType: "personal" },
        tx,
      );
      await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Kampus Uji Dua", institutionType: "company" },
        tx,
      );
      await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Ruang Uji Tiga", institutionType: "personal" },
        tx,
      );

      await expect(
        createInstitutionWorkspaceForUser(
          host,
          { displayName: "Ruang Uji Empat", institutionType: "personal" },
          tx,
        ),
      ).rejects.toMatchObject({ code: "recruiter_institution_limit_reached", httpStatus: 409 });

      expect(await ownedCountOf(tx, host)).toBe(3);
      expect(await institutionBySlug(tx, "ruang-uji-empat")).toBeNull();
    });
  });

  it("a second and third personal workspace are allowed", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, "uji.tiga@acme.example");
      await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Ruang Uji Satu", institutionType: "personal" },
        tx,
      );

      const second = await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Ruang Uji Dua", institutionType: "personal" },
        tx,
      );
      const third = await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Ruang Uji Tiga", institutionType: "personal" },
        tx,
      );

      expect(second.institutionType).toBe("personal");
      expect(third.institutionType).toBe("personal");
      expect(await ownedCountOf(tx, host)).toBe(3);
    });
  });

  it("an owner already above 3 keeps every workspace and cannot add one", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, "uji.empat@acme.example");
      await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Kampus Uji Satu", institutionType: "company" },
        tx,
      );
      await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Kampus Uji Dua", institutionType: "company" },
        tx,
      );
      await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Kampus Uji Tiga", institutionType: "company" },
        tx,
      );
      await plantPersonalWorkspace(tx, host, "ruang-uji-lama");

      await expect(
        createInstitutionWorkspaceForUser(
          host,
          { displayName: "Kampus Uji Empat", institutionType: "company" },
          tx,
        ),
      ).rejects.toMatchObject({ code: "recruiter_institution_limit_reached", httpStatus: 409 });

      expect(await ownedCountOf(tx, host)).toBe(4);
      expect(await institutionBySlug(tx, "kampus-uji-empat")).toBeNull();
    });
  });

  it("a personal create checks the username namespace on its base slug", async () => {
    await inRollback(async (tx) => {
      const participant = await signUpParticipant(tx, "uji.alya@acme.example");
      await setUsername(tx, participant, "uji_alya");
      const host = await signUpHost(tx, "uji.lima@acme.example");

      await expect(
        createInstitutionWorkspaceForUser(
          host,
          { displayName: "Uji Alya", institutionType: "personal" },
          tx,
        ),
      ).rejects.toMatchObject({
        code: "institution_slug_conflicts_with_username",
        httpStatus: 409,
      });

      expect(await ownedCountOf(tx, host)).toBe(0);
    });
  });

  it("a personal create checks the username namespace on a suffixed slug", async () => {
    await inRollback(async (tx) => {
      const firstHost = await signUpHost(tx, "uji.enam@acme.example");
      await createInstitutionWorkspaceForUser(
        firstHost,
        { displayName: "Acme Uji", institutionType: "company" },
        tx,
      );
      const participant = await signUpParticipant(tx, "acme.uji@acme.example");
      await setUsername(tx, participant, "acme_uji_2");
      const host = await signUpHost(tx, "uji.tujuh@acme.example");

      const shell = await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Acme Uji", institutionType: "personal" },
        tx,
      );

      expect(shell.slug).toBe("acme-uji-3");
      expect(shell.institutionType).toBe("personal");
    });
  });

  it("settings rename and re-slug a personal workspace", async () => {
    await inRollback(async (tx) => {
      const host = await signUpHost(tx, "uji.delapan@acme.example");
      await createInstitutionWorkspaceForUser(
        host,
        { displayName: "Komunitas Uji", institutionType: "personal" },
        tx,
      );
      const participant = await signUpParticipant(tx, "uji.dina@acme.example");
      await setUsername(tx, participant, "uji_dina");

      const renamed = await updateInstitutionWorkspaceForOwnerBySlug(
        host,
        "komunitas-uji",
        { displayName: "Komunitas Uji Baru", slug: "komunitas-uji-baru" },
        tx,
      );

      expect(renamed.displayName).toBe("Komunitas Uji Baru");
      expect(renamed.slug).toBe("komunitas-uji-baru");
      expect(await institutionBySlug(tx, "komunitas-uji-baru")).toEqual({
        displayName: "Komunitas Uji Baru",
        institutionType: "personal",
        slug: "komunitas-uji-baru",
      });

      await expect(
        updateInstitutionWorkspaceForOwnerBySlug(
          host,
          "komunitas-uji-baru",
          { slug: "uji-dina" },
          tx,
        ),
      ).rejects.toMatchObject({
        code: "institution_slug_conflicts_with_username",
        httpStatus: 409,
      });

      expect(await institutionBySlug(tx, "uji-dina")).toBeNull();
      expect(await institutionBySlug(tx, "komunitas-uji-baru")).not.toBeNull();
    });
  });
});
