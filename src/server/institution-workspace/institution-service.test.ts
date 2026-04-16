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

const createDbMockForCreation = (options: { slugConflictsBeforeSuccess: number }) => {
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

const createDbMockWithNoOwnerMembership = () => {
  const limit = vi.fn().mockResolvedValue([]);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));

  return {
    db: {
      select,
    } as unknown as Database,
  };
};

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
    expect(membershipRows[0]?.membershipRole).toBe("institution_admin");
    expect(membershipRows[0]?.status).toBe("active");
    expect(workspace.slug).toBe("universitas-nusantara-2");
    expect(workspace.ownerMembership.membershipRole).toBe("institution_admin");
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
});
