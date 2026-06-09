// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import type { Database } from "@/server/db/client";
import { institutionMemberships, institutions } from "@/server/db/schema";
import {
  createInstitutionWorkspaceForUser,
  createPersonalInstitutionForUser,
  findOwnedPersonalInstitution,
  institutionSlugCollidesWithUsername,
  InstitutionUpgradeError,
  rewritePersonalInstitutionSlugForUsername,
  upgradeInstitutionType,
  usernameCollidesWithInstitutionSlug,
  getInstitutionWorkspaceForOwnerBySlug,
  updateInstitutionWorkspaceForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";
import {
  InstitutionWorkspaceInputError,
  MAX_INSTITUTIONS_PER_RECRUITER,
} from "@/server/institution-workspace/institution-core";
import {
  InstitutionTypeTransitionError,
  MAX_PERSONAL_INSTITUTIONS_PER_RECRUITER,
} from "@/server/institution-workspace/institution-type";

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

  // Two reads precede the insert transaction: (1) the F7 owner-count query (returns 0, under limit),
  // (2) the Fix-C username-collision probe (returns [] — no colliding username). A thenable node
  // absorbs either chain shape (count: from→innerJoin→where; probe: from→where→limit).
  let creationSelectCalls = 0;
  const makeSeqNode = (result: unknown[]) => {
    const node: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where", "limit"]) {
      node[m] = () => node;
    }
    node.then = (resolve: (v: unknown) => void) => resolve(result);
    return node;
  };

  return {
    db: {
      select: vi.fn(() => {
        creationSelectCalls += 1;
        return makeSeqNode(creationSelectCalls === 1 ? [{ value: 0 }] : []);
      }),
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
// The owner-find now chains two inner joins (institution_memberships, then users for the owner
// username), so innerJoin returns itself to absorb any number of joins before where→limit.
const createDbMockWithMembershipStates = (options: { hasAnyMembership: boolean }) => {
  let selectCallCount = 0;
  const select = vi.fn(() => {
    selectCallCount += 1;
    const result = selectCallCount === 1 ? [] : options.hasAnyMembership ? [{ membershipId: "m_1" }] : [];

    const limit = vi.fn().mockResolvedValue(result);
    const chain: { where: ReturnType<typeof vi.fn>; innerJoin: ReturnType<typeof vi.fn> } = {
      where: vi.fn(() => ({ limit })),
      innerJoin: vi.fn(() => chain),
    };
    const from = vi.fn(() => chain);
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

  // F7 — institution creation limit (Step 6.5b)
  const createDbMockWithOwnerCount = (ownedCount: number) => {
    let selectCalls = 0;
    const tx = {
      insert: vi.fn((table: unknown) => {
        if (table === institutions) {
          return {
            values: (values: { displayName: string; slug: string; status: string }) => ({
              returning: async () => [
                {
                  institutionId: "inst_new",
                  institutionDisplayName: values.displayName,
                  institutionSlug: values.slug,
                  institutionStatus: values.status,
                  institutionCreatedAt: new Date("2026-06-04T00:00:00.000Z"),
                  institutionUpdatedAt: new Date("2026-06-04T00:00:00.000Z"),
                },
              ],
            }),
          };
        }
        if (table === institutionMemberships) {
          return {
            values: (values: { institutionId: string; userId: string; membershipRole: string; status: string }) => ({
              returning: async () => [
                {
                  membershipId: "mem_new",
                  membershipRole: values.membershipRole,
                  membershipStatus: values.status,
                  membershipJoinedAt: new Date("2026-06-04T00:00:00.000Z"),
                },
              ],
            }),
          };
        }
        throw new Error("Unexpected table");
      }),
    };
    // Select #1 — F7 owner-count query (returns ownedCount). Select #2 — Fix-C username-collision
    // probe (returns [] — no colliding username; collision is asserted separately below). A thenable
    // node absorbs either chain shape (count: from→innerJoin→where; probe: from→where→limit).
    const makeSeqNode = (result: unknown[]) => {
      const node: Record<string, unknown> = {};
      for (const m of ["from", "innerJoin", "where", "limit"]) {
        node[m] = () => node;
      }
      node.then = (resolve: (v: unknown) => void) => resolve(result);
      return node;
    };

    return {
      db: {
        select: vi.fn(() => {
          selectCalls += 1;
          return makeSeqNode(selectCalls === 1 ? [{ value: ownedCount }] : []);
        }),
        transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
      } as unknown as Database,
      getSelectCalls: () => selectCalls,
    };
  };

  it("F7: blocks creation when recruiter already owns MAX_INSTITUTIONS_PER_RECRUITER institutions", async () => {
    const { db } = createDbMockWithOwnerCount(MAX_INSTITUTIONS_PER_RECRUITER);
    await expect(
      createInstitutionWorkspaceForUser("user_at_limit", { displayName: "Kampus Baru" }, db),
    ).rejects.toThrow(InstitutionWorkspaceInputError);

    await createInstitutionWorkspaceForUser("user_at_limit", { displayName: "Kampus Baru" }, db).catch(
      (err: unknown) => {
        expect(err).toBeInstanceOf(InstitutionWorkspaceInputError);
        expect((err as InstitutionWorkspaceInputError).code).toBe("recruiter_institution_limit_reached");
        expect((err as InstitutionWorkspaceInputError).httpStatus).toBe(409);
      },
    );
  });

  it("F7: allows creation when recruiter is one below the limit", async () => {
    const { db } = createDbMockWithOwnerCount(MAX_INSTITUTIONS_PER_RECRUITER - 1);
    await expect(
      createInstitutionWorkspaceForUser("user_below_limit", { displayName: "Kampus Baru" }, db),
    ).resolves.toMatchObject({ ownerMembership: { membershipRole: "institution_owner" } });
  });

  it("F7: count is scoped to the requesting user — different users are independent", async () => {
    const dbA = createDbMockWithOwnerCount(MAX_INSTITUTIONS_PER_RECRUITER).db;
    const dbB = createDbMockWithOwnerCount(0).db;

    await expect(
      createInstitutionWorkspaceForUser("user_A_at_limit", { displayName: "Kampus A" }, dbA),
    ).rejects.toBeInstanceOf(InstitutionWorkspaceInputError);

    await expect(
      createInstitutionWorkspaceForUser("user_B_at_zero", { displayName: "Kampus B" }, dbB),
    ).resolves.toBeDefined();
  });

  // Step 6.5f.1 (Amendment) — the DB display_name NOT NULL constraint was loosened (migration
  // 0031) so personal institutions can store NULL. Full institutions must still get a stored name,
  // now enforced at the service layer via the create-input parser.
  it("Amendment 2: full create rejects an empty / whitespace display name at the service layer", async () => {
    const { db } = createDbMockWithOwnerCount(0);
    await expect(
      createInstitutionWorkspaceForUser("user_1", { displayName: "   " }, db),
    ).rejects.toMatchObject({ code: "institution_invalid_value" });
  });

  it("Amendment 2: full create rejects a missing display name at the service layer", async () => {
    const { db } = createDbMockWithOwnerCount(0);
    await expect(
      createInstitutionWorkspaceForUser("user_1", { slug: "kampus-tanpa-nama" }, db),
    ).rejects.toMatchObject({ code: "institution_invalid_value" });
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

// Step 6.5f.1 (+ Amendment) — personal institution creation. No name/slug input: display_name is
// written NULL, the name derives from the owner username at read time, and the slug derives from the
// owner username. The create path issues two reads (personal count, then owner-username load) before
// the insert transaction.
describe("createPersonalInstitutionForUser", () => {
  const makePersonalCreateDb = (personalCount: number, username = "owneruser") => {
    const insertedDisplayNames: (string | null)[] = [];
    const insertedTypes: (string | null)[] = [];
    const insertedSlugs: string[] = [];
    const membershipRoles: string[] = [];
    let selectCalls = 0;

    const tx = {
      insert: vi.fn((table: unknown) => {
        if (table === institutions) {
          return {
            values: (values: {
              displayName: string | null;
              slug: string;
              status: string;
              institutionType: string | null;
            }) => {
              insertedDisplayNames.push(values.displayName ?? null);
              insertedTypes.push(values.institutionType ?? null);
              insertedSlugs.push(values.slug);
              return {
                returning: async () => [
                  {
                    institutionId: "inst_p",
                    institutionDisplayName: values.displayName ?? null,
                    institutionSlug: values.slug,
                    institutionStatus: values.status,
                    institutionType: values.institutionType ?? null,
                    institutionCreatedAt: new Date("2026-06-08T00:00:00.000Z"),
                    institutionUpdatedAt: new Date("2026-06-08T00:00:00.000Z"),
                  },
                ],
              };
            },
          };
        }
        if (table === institutionMemberships) {
          return {
            values: (values: { membershipRole: string; status: string }) => {
              membershipRoles.push(values.membershipRole);
              return {
                returning: async () => [
                  {
                    membershipId: "mem_p",
                    membershipRole: values.membershipRole,
                    membershipStatus: values.status,
                    membershipJoinedAt: new Date("2026-06-08T00:00:00.000Z"),
                  },
                ],
              };
            },
          };
        }
        throw new Error("Unexpected table");
      }),
    };

    // Chainable thenable node: resolves to `result` when awaited at any terminal in the chain.
    const makeNode = (result: unknown[]) => {
      const node: Record<string, unknown> = {};
      for (const m of ["from", "innerJoin", "where", "limit", "orderBy"]) {
        node[m] = () => node;
      }
      node.then = (resolve: (v: unknown) => void) => resolve(result);
      return node;
    };

    return {
      db: {
        // Call 1 — personal-count query; call 2 — owner-username load.
        select: vi.fn(() => {
          selectCalls += 1;
          return selectCalls === 1 ? makeNode([{ value: personalCount }]) : makeNode([{ username }]);
        }),
        transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
      } as unknown as Database,
      insertedDisplayNames,
      insertedTypes,
      insertedSlugs,
      membershipRoles,
      getSelectCalls: () => selectCalls,
    };
  };

  it("creates a personal-typed institution with NULL display_name, name + slug from username", async () => {
    const { db, insertedDisplayNames, insertedTypes, insertedSlugs, membershipRoles } =
      makePersonalCreateDb(0, "owneruser");
    const workspace = await createPersonalInstitutionForUser("user_1", db);

    // Stored row: NULL display_name, personal type, slug derived from the owner username.
    expect(insertedDisplayNames).toEqual([null]);
    expect(insertedTypes).toEqual(["personal"]);
    expect(insertedSlugs).toEqual(["owneruser"]);
    expect(membershipRoles).toEqual(["institution_owner"]);

    // Resolved shell: name derived from the owner username; slug equals the username.
    expect(workspace.institutionType).toBe("personal");
    expect(workspace.displayName).toBe("owneruser's Institution");
    expect(workspace.slug).toBe("owneruser");
    expect(workspace.ownerMembership.membershipRole).toBe("institution_owner");
  });

  it("refuses a second personal institution (one-per-recruiter)", async () => {
    const { db, insertedTypes } = makePersonalCreateDb(MAX_PERSONAL_INSTITUTIONS_PER_RECRUITER);
    await createPersonalInstitutionForUser("user_at_personal_limit", db).catch((err: unknown) => {
      expect(err).toBeInstanceOf(InstitutionWorkspaceInputError);
      expect((err as InstitutionWorkspaceInputError).code).toBe("personal_institution_already_exists");
      expect((err as InstitutionWorkspaceInputError).httpStatus).toBe(409);
    });
    // The transaction insert must not have run.
    expect(insertedTypes).toEqual([]);
  });

  it("consults only the personal count + username — never the full-institution limit (seed 7)", async () => {
    // personalCount=0 succeeds regardless of how many FULL institutions the recruiter owns: the
    // personal path issues exactly one personal-count query and one owner-username load (2 selects),
    // and never the full-institution limit query.
    const { db, getSelectCalls } = makePersonalCreateDb(0);
    await createPersonalInstitutionForUser("recruiter_with_3_full", db);
    expect(getSelectCalls()).toBe(2);
  });
});

// Step 6.5f.1 — one-directional type-upgrade primitive (no live caller; F10 calls it in 6.5g).
describe("upgradeInstitutionType", () => {
  const ELEVATED = [{ recruiterVerifiedAt: new Date(), recruiterVerificationTier: "elevated" }];
  const MINIMAL = [{ recruiterVerifiedAt: new Date(), recruiterVerificationTier: "minimal" }];
  const UNVERIFIED = [{ recruiterVerifiedAt: null, recruiterVerificationTier: "unverified" }];

  // Sequenced db: each awaited terminal (.limit / .where / .returning) consumes the next result.
  // Order of awaited reads in upgradeInstitutionType:
  //   [0] recruiter tier, [1] institution+owner membership, [2] full-count, [3] update returning.
  const makeSequencedDb = (results: unknown[][]) => {
    let idx = 0;
    const node = (): Record<string, unknown> => {
      const n: Record<string, unknown> = {};
      for (const m of [
        "from",
        "innerJoin",
        "leftJoin",
        "where",
        "limit",
        "orderBy",
        "set",
        "returning",
        "values",
      ]) {
        n[m] = () => node();
      }
      n.then = (resolve: (v: unknown) => void) => resolve(results[idx++] ?? []);
      return n;
    };
    const db: Record<string, unknown> = {
      select: () => node(),
      update: () => node(),
      insert: () => node(),
      transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(db),
    };
    return db as unknown as Database;
  };

  it("flips personal → full subtype and returns the previous + new type", async () => {
    const db = makeSequencedDb([
      ELEVATED,
      [{ institutionType: "personal", ownerMembershipId: "m1" }],
      [{ value: 0 }],
      [{ institutionId: "inst_1" }],
    ]);
    const result = await upgradeInstitutionType("actor_1", "inst_1", "company", db);
    expect(result).toEqual({
      institutionId: "inst_1",
      previousType: "personal",
      institutionType: "company",
    });
  });

  it("flips a legacy NULL-type institution → full subtype (first declaration)", async () => {
    const db = makeSequencedDb([
      ELEVATED,
      [{ institutionType: null, ownerMembershipId: "m1" }],
      [{ value: 2 }], // 2 existing full + this one = 3 ≤ limit
      [{ institutionId: "inst_1" }],
    ]);
    const result = await upgradeInstitutionType("actor_1", "inst_1", "university", db);
    expect(result.previousType).toBeNull();
    expect(result.institutionType).toBe("university");
  });

  it("refuses an upgrade when the actor is below the elevated tier", async () => {
    const db = makeSequencedDb([MINIMAL]);
    await expect(upgradeInstitutionType("actor_1", "inst_1", "company", db)).rejects.toMatchObject({
      code: "institution_upgrade_tier_insufficient",
      status: 403,
    });
  });

  it("refuses an upgrade when the recruiter mode is not verified", async () => {
    const db = makeSequencedDb([UNVERIFIED]);
    await expect(upgradeInstitutionType("actor_1", "inst_1", "company", db)).rejects.toBeInstanceOf(
      InstitutionUpgradeError,
    );
  });

  it("returns 404 when the institution does not exist", async () => {
    const db = makeSequencedDb([ELEVATED, []]);
    await expect(upgradeInstitutionType("actor_1", "inst_x", "company", db)).rejects.toMatchObject({
      code: "institution_not_found",
      status: 404,
    });
  });

  it("forbids an upgrade by a non-owner of the institution", async () => {
    const db = makeSequencedDb([
      ELEVATED,
      [{ institutionType: "personal", ownerMembershipId: null }],
    ]);
    await expect(upgradeInstitutionType("actor_1", "inst_1", "company", db)).rejects.toMatchObject({
      code: "institution_upgrade_forbidden",
      status: 403,
    });
  });

  it("propagates the fail-closed transition guard on a full → different-full change", async () => {
    const db = makeSequencedDb([
      ELEVATED,
      [{ institutionType: "company", ownerMembershipId: "m1" }],
    ]);
    await expect(
      upgradeInstitutionType("actor_1", "inst_1", "foundation", db),
    ).rejects.toBeInstanceOf(InstitutionTypeTransitionError);
  });

  it("re-checks the full limit INCLUDING the upgrading institution (seed 11)", async () => {
    const db = makeSequencedDb([
      ELEVATED,
      [{ institutionType: "personal", ownerMembershipId: "m1" }],
      [{ value: MAX_INSTITUTIONS_PER_RECRUITER }], // already at the limit → +1 exceeds
    ]);
    await expect(upgradeInstitutionType("actor_1", "inst_1", "company", db)).rejects.toMatchObject({
      code: "institution_upgrade_limit_reached",
      status: 409,
    });
  });

  it("throws a conflict when the CAS flip matches no row (concurrent change)", async () => {
    const db = makeSequencedDb([
      ELEVATED,
      [{ institutionType: "personal", ownerMembershipId: "m1" }],
      [{ value: 0 }],
      [], // update returning empty → concurrent modification
    ]);
    await expect(upgradeInstitutionType("actor_1", "inst_1", "company", db)).rejects.toMatchObject({
      code: "institution_upgrade_conflict",
      status: 409,
    });
  });
});

// Step 6.5f.1 (post-step-9) — personal institution slug follows the owner's username. A username
// change rewrites the slug and re-indexes the institution's published competitions.
describe("personal institution slug ↔ username sync", () => {
  // Generic thenable chain mock. `selectResults` are returned in call order for every awaited
  // read (collision probes and the published-competition query). The slug written by the single
  // UPDATE is captured for assertion.
  const makeSlugSyncDb = (selectResults: unknown[][]) => {
    let idx = 0;
    const captured: { updatedSlug: string | null } = { updatedSlug: null };

    const node = (): Record<string, unknown> => {
      const n: Record<string, unknown> = {};
      for (const m of ["from", "innerJoin", "where", "limit"]) {
        n[m] = () => node();
      }
      n.then = (resolve: (v: unknown) => void) => resolve(selectResults[idx++] ?? []);
      return n;
    };

    const db = {
      select: () => node(),
      update: () => ({
        set: (values: { slug?: string }) => {
          captured.updatedSlug = values.slug ?? null;
          return { where: () => node() };
        },
      }),
    } as unknown as Database;

    return { db, captured };
  };

  describe("findOwnedPersonalInstitution", () => {
    it("returns the institution when the user actively owns a personal institution", async () => {
      const { db } = makeSlugSyncDb([[{ institutionId: "inst_1", slug: "alice" }]]);
      await expect(findOwnedPersonalInstitution("user_1", db)).resolves.toEqual({
        institutionId: "inst_1",
        slug: "alice",
      });
    });

    it("returns null when the user owns no personal institution", async () => {
      const { db } = makeSlugSyncDb([[]]);
      await expect(findOwnedPersonalInstitution("user_1", db)).resolves.toBeNull();
    });
  });

  describe("usernameCollidesWithInstitutionSlug", () => {
    it("returns true when another institution already holds the username-derived slug", async () => {
      const { db } = makeSlugSyncDb([[{ id: "inst_other" }]]);
      await expect(
        usernameCollidesWithInstitutionSlug("universitas-indonesia", null, db),
      ).resolves.toBe(true);
    });

    it("returns false when no other institution holds the slug", async () => {
      const { db } = makeSlugSyncDb([[]]);
      await expect(usernameCollidesWithInstitutionSlug("bob", "inst_self", db)).resolves.toBe(false);
    });
  });

  describe("rewritePersonalInstitutionSlugForUsername", () => {
    it("rewrites the slug to the username-derived base and returns published competition ids", async () => {
      const { db, captured } = makeSlugSyncDb([
        [], // collision probe attempt 0 → base "bob" is free
        [], // UPDATE ... WHERE resolve (ignored)
        [{ id: "comp_1" }, { id: "comp_2" }], // published competitions to re-sync
      ]);

      const ids = await rewritePersonalInstitutionSlugForUsername("inst_1", "bob", db);

      expect(captured.updatedSlug).toBe("bob");
      expect(ids).toEqual(["comp_1", "comp_2"]);
    });

    it("no-op self-match: a username equal to the current slug resolves to itself (self excluded)", async () => {
      const { db, captured } = makeSlugSyncDb([
        [], // collision probe excludes self → base "alice" is free
        [], // UPDATE resolve
        [], // no published competitions
      ]);

      const ids = await rewritePersonalInstitutionSlugForUsername("inst_1", "alice", db);

      expect(captured.updatedSlug).toBe("alice");
      expect(ids).toEqual([]);
    });

    it("falls back to a numeric suffix when the base slug is held by another institution", async () => {
      const { db, captured } = makeSlugSyncDb([
        [{ id: "inst_other" }], // attempt 0 → base "shared" taken by another institution
        [], // attempt 1 → "shared-2" free
        [], // UPDATE resolve
        [], // no published competitions
      ]);

      const ids = await rewritePersonalInstitutionSlugForUsername("inst_1", "shared", db);

      expect(captured.updatedSlug).toBe("shared-2");
      expect(ids).toEqual([]);
    });
  });
});

// A personal institution's slug derives from the owner username and is read-only in institution
// settings (it changes only when the username changes). The settings update must ignore a slug
// patch on the personal path — this is the authoritative server-side enforcement behind the
// read-only field in the settings UI.
describe("updateInstitutionWorkspaceForOwnerBySlug — slug editability by type", () => {
  const ownerRow = (overrides: Record<string, unknown>) => ({
    institutionId: "inst_1",
    institutionDisplayName: null,
    institutionSlug: "alice",
    institutionStatus: "inactive",
    institutionType: null,
    institutionCreatedAt: new Date("2026-06-08T00:00:00.000Z"),
    institutionUpdatedAt: new Date("2026-06-08T00:00:00.000Z"),
    membershipId: "mem_1",
    membershipRole: "institution_owner",
    membershipStatus: "active",
    membershipJoinedAt: new Date("2026-06-08T00:00:00.000Z"),
    ownerUsername: "alice",
    ...overrides,
  });

  const makeSettingsDb = (selectResults: unknown[][]) => {
    let idx = 0;
    const captured: { updatedSlug: string | null; updateCalls: number } = {
      updatedSlug: null,
      updateCalls: 0,
    };
    const node = (): Record<string, unknown> => {
      const n: Record<string, unknown> = {};
      for (const m of ["from", "innerJoin", "leftJoin", "where", "limit"]) {
        n[m] = () => node();
      }
      n.then = (resolve: (v: unknown) => void) => resolve(selectResults[idx++] ?? []);
      return n;
    };
    const db = {
      select: () => node(),
      update: () => ({
        set: (values: { slug?: string }) => {
          captured.updateCalls += 1;
          captured.updatedSlug = values.slug ?? null;
          return { where: () => node() };
        },
      }),
    } as unknown as Database;
    return { db, captured };
  };

  it("ignores a slug patch on a personal institution (slug stays bound to the username)", async () => {
    const { db, captured } = makeSettingsDb([
      [ownerRow({ institutionType: "personal", institutionSlug: "alice" })],
    ]);

    const result = await updateInstitutionWorkspaceForOwnerBySlug(
      "user_1",
      "alice",
      { slug: "chosen-by-owner" },
      db,
    );

    expect(captured.updateCalls).toBe(0);
    expect(result.slug).toBe("alice");
  });

  it("still applies a slug patch on a full institution", async () => {
    const { db, captured } = makeSettingsDb([
      [ownerRow({ institutionType: null, institutionSlug: "kampus-lama", institutionDisplayName: "Kampus Lama" })],
      [], // Fix D: institutionSlugCollidesWithUsername("kampus-baru") → no colliding username
      [], // UPDATE resolve
      [ownerRow({ institutionType: null, institutionSlug: "kampus-baru", institutionDisplayName: "Kampus Lama" })],
    ]);

    const result = await updateInstitutionWorkspaceForOwnerBySlug(
      "user_1",
      "kampus-lama",
      { slug: "kampus-baru" },
      db,
    );

    expect(captured.updateCalls).toBe(1);
    expect(captured.updatedSlug).toBe("kampus-baru");
    expect(result.slug).toBe("kampus-baru");
  });

  // Fix D (audit follow-up, F1-D3): the full-institution slug-change path validates the proposed slug
  // against existing usernames via the Fix C helper. Closes the gap where a settings rename could
  // create a slug==username collision the create-path check did not cover.
  it("Fix D: rejects a full-institution slug change that collides with an existing username", async () => {
    const { db, captured } = makeSettingsDb([
      [ownerRow({ institutionType: null, institutionSlug: "kampus-lama", institutionDisplayName: "Kampus Lama" })],
      [{ id: "user_alice" }], // Fix D probe: username "alice" already occupies this slot
    ]);

    await expect(
      updateInstitutionWorkspaceForOwnerBySlug("user_1", "kampus-lama", { slug: "alice" }, db),
    ).rejects.toMatchObject({ code: "institution_slug_conflicts_with_username", httpStatus: 409 });

    // The slug must NOT have been written.
    expect(captured.updateCalls).toBe(0);
    expect(captured.updatedSlug).toBeNull();
  });

  it("Fix D: rejects via the `-`→`_` bijection (slug `alice-bob` resolves to username `alice_bob`)", async () => {
    // The helper's slug→username normalization is unit-proven in the "institutionSlugCollidesWithUsername
    // (Fix C)" describe; here we confirm the settings path wires it so a hyphenated slug matching an
    // underscore username is rejected.
    const { db, captured } = makeSettingsDb([
      [ownerRow({ institutionType: null, institutionSlug: "kampus-lama", institutionDisplayName: "Kampus Lama" })],
      [{ id: "user_alice_bob" }], // username "alice_bob" occupies the slot slug "alice-bob" maps to
    ]);

    await expect(
      updateInstitutionWorkspaceForOwnerBySlug("user_1", "kampus-lama", { slug: "alice-bob" }, db),
    ).rejects.toMatchObject({ code: "institution_slug_conflicts_with_username", httpStatus: 409 });
    expect(captured.updateCalls).toBe(0);
  });

  it("Fix D: reserved-word slug rejection still fires on settings slug-change (parse layer intact)", async () => {
    // parseInstitutionWorkspaceSettingsPatch rejects a reserved slug before any DB read; the new Fix D
    // probe must not displace it. No owner row is consulted.
    const { db, captured } = makeSettingsDb([]);

    await expect(
      updateInstitutionWorkspaceForOwnerBySlug("user_1", "kampus-lama", { slug: "admin" }, db),
    ).rejects.toMatchObject({ code: "institution_slug_reserved", httpStatus: 422 });
    expect(captured.updateCalls).toBe(0);
  });

  it("Fix D: institutions.slug uniqueness rejection still fires (unique-violation catch intact)", async () => {
    // Full institution, slug clears the username check, but the UPDATE hits institutions_slug_unique_idx
    // (another institution holds the slug). The existing catch maps it to institution_invalid_value.
    let idx = 0;
    const ownerSeed = {
      institutionId: "inst_1",
      institutionDisplayName: "Kampus Lama",
      institutionSlug: "kampus-lama",
      institutionStatus: "inactive",
      institutionType: null,
      institutionCreatedAt: new Date("2026-06-08T00:00:00.000Z"),
      institutionUpdatedAt: new Date("2026-06-08T00:00:00.000Z"),
      membershipId: "mem_1",
      membershipRole: "institution_owner",
      membershipStatus: "active",
      membershipJoinedAt: new Date("2026-06-08T00:00:00.000Z"),
      ownerUsername: "owner",
    };
    const selectResults: unknown[][] = [[ownerSeed], []]; // owner lookup; Fix D probe → no username collision
    const node = (): Record<string, unknown> => {
      const n: Record<string, unknown> = {};
      for (const m of ["from", "innerJoin", "leftJoin", "where", "limit"]) {
        n[m] = () => node();
      }
      n.then = (resolve: (v: unknown) => void) => resolve(selectResults[idx++] ?? []);
      return n;
    };
    const db = {
      select: () => node(),
      update: () => ({
        set: () => ({
          where: () => {
            throw { code: "23505", constraint: "institutions_slug_unique_idx" };
          },
        }),
      }),
    } as unknown as Database;

    await expect(
      updateInstitutionWorkspaceForOwnerBySlug("user_1", "kampus-lama", { slug: "kampus-baru" }, db),
    ).rejects.toMatchObject({ code: "institution_invalid_value", details: { fields: ["slug"] } });
  });
});

// Fix C (Step 6.5f.1, post-step-9) — a new full institution's slug shares one flat namespace with
// usernames and may not take a slug an existing user's username already occupies. The mirror of the
// Fix-B username-change guard, in the opposite direction.
describe("institutionSlugCollidesWithUsername (Fix C)", () => {
  // Captures the username the helper actually looks up. The bound value rides in the drizzle eq()
  // condition's queryChunks; the single string chunk is the parameter. This lets the test prove the
  // slug→username normalization (`-`→`_`) without a live database.
  const extractLookedUpUsername = (cond: unknown): string | undefined => {
    const chunks = (cond as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks ?? [];
    return chunks.find((c) => typeof c?.value === "string")?.value as string | undefined;
  };

  const makeProbeDb = (probeResult: unknown[]) => {
    const captured: { lookedUpUsername?: string } = {};
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((cond: unknown) => {
            captured.lookedUpUsername = extractLookedUpUsername(cond);
            return { limit: vi.fn(async () => probeResult) };
          }),
        })),
      })),
    } as unknown as Database;
    return { db, captured };
  };

  it("normalizes the proposed slug back to username space (`-`→`_`) and reports a collision", async () => {
    const { db, captured } = makeProbeDb([{ id: "user_alice_bob" }]);

    await expect(institutionSlugCollidesWithUsername("alice-bob", db)).resolves.toBe(true);
    // Parity: slug `alice-bob` must look up the username `alice_bob`, not the raw `alice-bob`.
    expect(captured.lookedUpUsername).toBe("alice_bob");
  });

  it("looks up a hyphenless slug unchanged and reports a collision", async () => {
    const { db, captured } = makeProbeDb([{ id: "user_alice" }]);

    await expect(institutionSlugCollidesWithUsername("alice", db)).resolves.toBe(true);
    expect(captured.lookedUpUsername).toBe("alice");
  });

  it("reports no collision when no username occupies the slot", async () => {
    const { db } = makeProbeDb([]);

    await expect(institutionSlugCollidesWithUsername("kampus-nusantara", db)).resolves.toBe(false);
  });
});

describe("createInstitutionWorkspaceForUser — Fix C username-collision gate", () => {
  // Three reads precede (or replace) the insert: (1) F7 owner count, (2) the Fix-C username probe.
  // A thenable node absorbs either chain shape. The insert transaction is a spy so a rejection can
  // be proven to write nothing.
  const makeCreateDb = (options: { ownedCount: number; usernameCollision: boolean }) => {
    let selectCalls = 0;
    const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => {
      const tx = {
        insert: vi.fn((table: unknown) => {
          if (table === institutions) {
            return {
              values: (values: { displayName: string; slug: string; status: string }) => ({
                returning: async () => [
                  {
                    institutionId: "inst_new",
                    institutionDisplayName: values.displayName,
                    institutionSlug: values.slug,
                    institutionStatus: values.status,
                    institutionCreatedAt: new Date("2026-06-09T00:00:00.000Z"),
                    institutionUpdatedAt: new Date("2026-06-09T00:00:00.000Z"),
                  },
                ],
              }),
            };
          }
          return {
            values: (values: { membershipRole: string; status: string }) => ({
              returning: async () => [
                {
                  membershipId: "mem_new",
                  membershipRole: values.membershipRole,
                  membershipStatus: values.status,
                  membershipJoinedAt: new Date("2026-06-09T00:00:00.000Z"),
                },
              ],
            }),
          };
        }),
      };
      return cb(tx);
    });

    const makeSeqNode = (result: unknown[]) => {
      const node: Record<string, unknown> = {};
      for (const m of ["from", "innerJoin", "where", "limit"]) {
        node[m] = () => node;
      }
      node.then = (resolve: (v: unknown) => void) => resolve(result);
      return node;
    };

    const db = {
      select: vi.fn(() => {
        selectCalls += 1;
        if (selectCalls === 1) return makeSeqNode([{ value: options.ownedCount }]);
        return makeSeqNode(options.usernameCollision ? [{ id: "user_taken" }] : []);
      }),
      transaction,
    } as unknown as Database;

    return { db, transaction };
  };

  it("rejects with 409 institution_slug_conflicts_with_username and writes nothing", async () => {
    const { db, transaction } = makeCreateDb({ ownedCount: 0, usernameCollision: true });

    await expect(
      createInstitutionWorkspaceForUser("user_1", { displayName: "alice" }, db),
    ).rejects.toMatchObject({
      code: "institution_slug_conflicts_with_username",
      httpStatus: 409,
    });
    // Rejected before the insert transaction — no institution row created.
    expect(transaction).not.toHaveBeenCalled();
  });

  it("creates the institution when no username occupies the slug", async () => {
    const { db, transaction } = makeCreateDb({ ownedCount: 0, usernameCollision: false });

    await expect(
      createInstitutionWorkspaceForUser("user_1", { displayName: "Universitas Nusantara" }, db),
    ).resolves.toMatchObject({ slug: "universitas-nusantara" });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects a reserved-word slug before reaching the username probe (ordering preserved)", async () => {
    const { db, transaction } = makeCreateDb({ ownedCount: 0, usernameCollision: true });

    // `personal` is a reserved word; parse rejects it (422) before the Fix-C probe or any insert.
    await expect(
      createInstitutionWorkspaceForUser("user_1", { displayName: "Kampus", slug: "personal" }, db),
    ).rejects.toMatchObject({ code: "institution_slug_reserved", httpStatus: 422 });
    expect(transaction).not.toHaveBeenCalled();
  });
});

// Fix E (audit follow-up) — the slug-collision suffix loop re-checks each SUFFIXED candidate against
// usernames, not only the base slug. Scenario: institution slug `target` is taken (forces a suffix
// bump), and username `target_2` exists (occupies slug `target-2`), so the loop must skip `target-2`
// and land on `target-3`. This is the rare two-collision sequence; the base-slug check at the top of
// createInstitutionWorkspaceForUser handles the common case.
describe("createInstitutionWorkspaceForUser — Fix E suffixed-slug username re-check", () => {
  it("bumps past a suffixed candidate that collides with a username", async () => {
    const attemptedInstitutionSlugs: string[] = [];
    // Ordered read results:
    //   1 owner count → 0; 2 base Fix-C probe ("target") → none; 3 Fix-E attempt0 ("target") → none;
    //   4 Fix-E attempt1 ("target-2") → username "target_2" collides; 5 Fix-E attempt2 ("target-3") → none.
    const selectResults: unknown[][] = [
      [{ value: 0 }],
      [],
      [],
      [{ id: "user_target_2" }],
      [],
    ];
    let selectIdx = 0;

    const makeSeqNode = (result: unknown[]) => {
      const node: Record<string, unknown> = {};
      for (const m of ["from", "innerJoin", "where", "limit"]) {
        node[m] = () => node;
      }
      node.then = (resolve: (v: unknown) => void) => resolve(result);
      return node;
    };

    const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => {
      const tx = {
        insert: vi.fn((table: unknown) => {
          if (table === institutions) {
            return {
              values: (values: { displayName: string | null; slug: string; status: string }) => {
                attemptedInstitutionSlugs.push(values.slug);
                return {
                  returning: async () => {
                    // institutions.slug `target` is already taken — force the suffix bump.
                    if (values.slug === "target") {
                      throw { code: "23505", constraint: "institutions_slug_unique_idx" };
                    }
                    return [
                      {
                        institutionId: "inst_new",
                        institutionDisplayName: values.displayName,
                        institutionSlug: values.slug,
                        institutionStatus: values.status,
                        institutionCreatedAt: new Date("2026-06-09T00:00:00.000Z"),
                        institutionUpdatedAt: new Date("2026-06-09T00:00:00.000Z"),
                      },
                    ];
                  },
                };
              },
            };
          }
          return {
            values: (values: { membershipRole: string; status: string }) => ({
              returning: async () => [
                {
                  membershipId: "mem_new",
                  membershipRole: values.membershipRole,
                  membershipStatus: values.status,
                  membershipJoinedAt: new Date("2026-06-09T00:00:00.000Z"),
                },
              ],
            }),
          };
        }),
      };
      return cb(tx);
    });

    const db = {
      select: vi.fn(() => makeSeqNode(selectResults[selectIdx++] ?? [])),
      transaction,
    } as unknown as Database;

    const workspace = await createInstitutionWorkspaceForUser(
      "user_1",
      { displayName: "Target" },
      db,
    );

    // Final slug skips the username-colliding `target-2` and lands on `target-3`.
    expect(workspace.slug).toBe("target-3");
    // `target` was attempted (slug-unique violation) and `target-3` succeeded; `target-2` never
    // reached insert because Fix E skipped it on the username collision.
    expect(attemptedInstitutionSlugs).toEqual(["target", "target-3"]);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
