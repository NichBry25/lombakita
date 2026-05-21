// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import type { Database } from "@/server/db/client";
import { institutionMemberships, institutions } from "@/server/db/schema";
import {
  createInstitutionWorkspaceForUser,
  getInstitutionWorkspaceForOwnerBySlug,
  updateInstitutionWorkspaceForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";

type CreationConflictShape = "outer" | "wrapped";

const createDbMockForCreation = (options: {
  slugConflictsBeforeSuccess: number;
  conflictShape?: CreationConflictShape;
}) => {
  const attemptedInstitutionSlugs: string[] = [];
  const institutionRows: Array<{
    displayName: string;
    slug: string;
    status: string;
  }> = [];
  const membershipRows: Array<{
    institutionId: string;
    userId: string;
    membershipRole: string;
    status: string;
  }> = [];
  let institutionInsertCount = 0;

  const tx = {
    insert: vi.fn((table: unknown) => {
      if (table === institutions) {
        return {
          values: (values: { displayName: string; slug: string; status: string }) => {
            attemptedInstitutionSlugs.push(values.slug);

            return {
              returning: async () => {
                institutionInsertCount += 1;

                if (institutionInsertCount <= options.slugConflictsBeforeSuccess) {
                  if (options.conflictShape === "wrapped") {
                    // Mirrors the real Drizzle + postgres.js error shape: outer
                    // object carries `query`/`params`/`cause` only; the Postgres
                    // payload lives on `cause`.
                    const wrapped = new Error("Failed query: insert into institutions");
                    (wrapped as unknown as { cause: unknown }).cause = {
                      code: "23505",
                      constraint_name: "institutions_slug_unique_idx",
                      detail: `Key (slug)=(${values.slug}) already exists.`,
                    };
                    throw wrapped;
                  }

                  throw {
                    code: "23505",
                    constraint: "institutions_slug_unique_idx",
                  };
                }

                institutionRows.push(values);

                return [
                  {
                    institutionId: "inst_1",
                    institutionDisplayName: values.displayName,
                    institutionSlug: values.slug,
                    institutionStatus: values.status,
                    institutionCreatedAt: new Date("2026-04-16T10:00:00.000Z"),
                    institutionUpdatedAt: new Date("2026-04-16T10:00:00.000Z"),
                  },
                ];
              },
            };
          },
        };
      }

      if (table === institutionMemberships) {
        return {
          values: (values: {
            institutionId: string;
            userId: string;
            membershipRole: string;
            status: string;
          }) => {
            membershipRows.push(values);

            return {
              returning: async () => {
                return [
                  {
                    membershipId: "membership_1",
                    membershipRole: values.membershipRole,
                    membershipStatus: values.status,
                    membershipJoinedAt: new Date("2026-04-16T10:00:00.000Z"),
                  },
                ];
              },
            };
          },
        };
      }

      throw new Error("Unexpected insert table in test mock");
    }),
  };

  return {
    db: {
      transaction: vi.fn(async (callback: (context: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as Database,
    attemptedInstitutionSlugs,
    institutionRows,
    membershipRows,
  };
};

// Two-query mock: first select is the owner-membership JOIN (returns []), second
// select is the any-membership probe used by denyInstitutionWorkspaceAccess to
// distinguish "not part of institution" from "member but not owner".
const createDbMockWithMembershipStates = (options: { hasAnyMembership: boolean }) => {
  let selectCallCount = 0;
  const select = vi.fn(() => {
    selectCallCount += 1;
    const result = selectCallCount === 1 ? [] : options.hasAnyMembership ? [{ membershipId: "m_1" }] : [];

    const limit = vi.fn().mockResolvedValue(result);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    return { from };
  });

  return {
    db: {
      select,
    } as unknown as Database,
  };
};

const createDbMockWithNoOwnerMembership = () =>
  createDbMockWithMembershipStates({ hasAnyMembership: false });

describe("institution-service", () => {
  it("creates institution workspace with owner membership and slug retry on conflict", async () => {
    const { db, attemptedInstitutionSlugs, institutionRows, membershipRows } =
      createDbMockForCreation({
        slugConflictsBeforeSuccess: 1,
      });

    const workspace = await createInstitutionWorkspaceForUser(
      "user_1",
      {
        displayName: "Universitas Nusantara",
      },
      db,
    );

    expect(attemptedInstitutionSlugs).toEqual(["universitas-nusantara", "universitas-nusantara-2"]);
    expect(institutionRows).toHaveLength(1);
    expect(institutionRows[0]?.status).toBe("inactive");
    expect(membershipRows).toHaveLength(1);
    expect(membershipRows[0]?.membershipRole).toBe("institution_owner");
    expect(membershipRows[0]?.status).toBe("active");
    expect(workspace.slug).toBe("universitas-nusantara-2");
    expect(workspace.ownerMembership.membershipRole).toBe("institution_owner");
  });

  it("denies settings read when user is not owner of the institution slug", async () => {
    const { db } = createDbMockWithNoOwnerMembership();

    await expect(getInstitutionWorkspaceForOwnerBySlug("user_1", "kampus-a", db)).rejects.toThrow(
      AccessError,
    );
  });

  it("denies settings update when user is not owner of the institution slug", async () => {
    const { db } = createDbMockWithNoOwnerMembership();

    await expect(
      updateInstitutionWorkspaceForOwnerBySlug(
        "user_1",
        "kampus-a",
        {
          displayName: "Nama Baru Kampus A",
        },
        db,
      ),
    ).rejects.toThrow(AccessError);
  });

  it("rejects settings read with 'owner required' when user is a member but not the owner", async () => {
    const { db } = createDbMockWithMembershipStates({ hasAnyMembership: true });

    await expect(
      getInstitutionWorkspaceForOwnerBySlug("user_1", "kampus-a", db),
    ).rejects.toThrow(/owner access required/i);
  });

  it("rejects settings read with 'not part of institution' when user has no membership at all", async () => {
    const { db } = createDbMockWithMembershipStates({ hasAnyMembership: false });

    await expect(
      getInstitutionWorkspaceForOwnerBySlug("user_1", "kampus-a", db),
    ).rejects.toThrow(/not part of this institution/i);
  });

  it("retries on slug collision when the postgres error is wrapped under .cause (Drizzle shape)", async () => {
    const { db, attemptedInstitutionSlugs, institutionRows } = createDbMockForCreation({
      slugConflictsBeforeSuccess: 1,
      conflictShape: "wrapped",
    });

    const workspace = await createInstitutionWorkspaceForUser(
      "user_1",
      { displayName: "Universitas Nusantara" },
      db,
    );

    expect(attemptedInstitutionSlugs).toEqual([
      "universitas-nusantara",
      "universitas-nusantara-2",
    ]);
    expect(institutionRows).toHaveLength(1);
    expect(workspace.slug).toBe("universitas-nusantara-2");
  });
});
