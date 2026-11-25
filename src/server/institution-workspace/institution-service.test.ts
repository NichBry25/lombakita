// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/auth/access-core";
import type { Database } from "@/server/db/client";
import { institutionMemberships, institutions } from "@/server/db/schema";
import {
  NEW_INSTITUTION_DEFAULT_STATUS,
  createInstitutionWorkspaceForUser,
  findOwnedPersonalInstitution,
  institutionSlugCollidesWithUsername,
  usernameCollidesWithInstitutionSlug,
  getInstitutionWorkspaceForOwnerBySlug,
  updateInstitutionWorkspaceForOwnerBySlug,
} from "@/server/institution-workspace/institution-service";
import {
  InstitutionWorkspaceInputError,
  MAX_INSTITUTIONS_PER_RECRUITER,
} from "@/server/institution-workspace/institution-core";

// Every create-path insert transaction now (1) acquires a per-owner advisory lock via tx.execute and
// (2) re-counts the owner's institutions under that lock via tx.select before inserting (the true cap
// guard). These helpers let each tx mock satisfy both without duplicating the thenable boilerplate.
// `inTxCount` is what the in-transaction re-count returns; pass an optional `capturedLockKeys` array
// to record the advisory-lock key the code derives (proves per-owner keying / cross-owner independence).
//
// `status` is the answer the de-identified-account guard gets: that guard is the first read in every
// create transaction and it takes its row with `.for("update")`, so the node carries one alongside
// the thenable the count queries are awaited through.
const makeTxCountNode = (value: number, status: "active" | "deactivated" = "active") => {
  const node: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "limit"]) node[m] = () => node;
  node.for = vi.fn().mockResolvedValue([{ status }]);
  node.then = (resolve: (v: unknown) => void) => resolve([{ value }]);
  return node;
};

const txCapGuards = (
  inTxCount: number,
  capturedLockKeys?: string[],
  status: "active" | "deactivated" = "active",
) => ({
  execute: vi.fn((query?: unknown) => {
    // drizzle stores an interpolated raw string as a primitive string chunk (parameterized at build
    // time), not a Param object — so match the chunk that IS the "inst_owner_cap:<userId>" string.
    const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
    const key = chunks.find(
      (c): c is string => typeof c === "string" && c.startsWith("inst_owner_cap:"),
    );
    if (key && capturedLockKeys) capturedLockKeys.push(key);
    return Promise.resolve([]);
  }),
  select: vi.fn(() => makeTxCountNode(inTxCount, status)),
});

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
    ...txCapGuards(0),
    insert: vi.fn((table: unknown) => {
      if (table === institutions) {
        return {
          values: (values: {
            displayName: string;
            slug: string;
            status: string;
            institutionType: string | null;
          }) => {
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
                    institutionType: values.institutionType,
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
    const result =
      selectCallCount === 1 ? [] : options.hasAnyMembership ? [{ membershipId: "m_1" }] : [];

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
  it("declares the same default status in the schema as every creation path writes", () => {
    // Two spellings of one fact. The column default was `active` while every creation path wrote
    // `inactive`, so a fixture that omitted the column got a state production could not produce.
    expect(institutions.status.default).toBe(NEW_INSTITUTION_DEFAULT_STATUS);
  });

  it("creates institution workspace with owner membership and slug retry on conflict", async () => {
    const { db, attemptedInstitutionSlugs, institutionRows, membershipRows } =
      createDbMockForCreation({
        slugConflictsBeforeSuccess: 1,
      });

    const workspace = await createInstitutionWorkspaceForUser(
      "user_1",
      {
        displayName: "Universitas Nusantara",
        institutionType: "university",
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

  it("refuses a de-identified account with 409 account_deactivated, before the cap lock", async () => {
    // Creating an institution gives the account an owner membership in it, and a tombstone is not an
    // account anyone can act as. The refusal is the transaction's first act, which the empty lock
    // record shows: an account whose data is gone gets neither an institution nor a lock held on its
    // behalf while that is decided.
    const capturedLockKeys: string[] = [];
    const tx = txCapGuards(0, capturedLockKeys, "deactivated");

    // The two reads that precede the transaction: the owner count, then the username-collision
    // probe. Both a thenable node, as elsewhere in this file.
    let selectCalls = 0;
    const makeSeqNode = (result: unknown[]) => {
      const node: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "where", "limit"]) node[method] = () => node;
      node.then = (resolve: (rows: unknown[]) => void) => resolve(result);
      return node;
    };

    const db = {
      select: vi.fn(() => {
        selectCalls += 1;
        return makeSeqNode(selectCalls === 1 ? [{ value: 0 }] : []);
      }),
      transaction: vi.fn(async (callback: (context: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as Database;

    await expect(
      createInstitutionWorkspaceForUser(
        "gone_user",
        { displayName: "Kampus Hantu", institutionType: "company" },
        db,
      ),
    ).rejects.toMatchObject({ code: "account_deactivated", httpStatus: 409 });

    // The guard's own read is the only one the transaction made: the owner count it would otherwise
    // have taken the lock for never ran.
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(capturedLockKeys).toEqual([]);
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

    await expect(getInstitutionWorkspaceForOwnerBySlug("user_1", "kampus-a", db)).rejects.toThrow(
      /owner access required/i,
    );
  });

  it("rejects settings read with 'not part of institution' when user has no membership at all", async () => {
    const { db } = createDbMockWithMembershipStates({ hasAnyMembership: false });

    await expect(getInstitutionWorkspaceForOwnerBySlug("user_1", "kampus-a", db)).rejects.toThrow(
      /not part of this institution/i,
    );
  });

  // F7 — institution creation limit (Step 6.5b)
  const createDbMockWithOwnerCount = (ownedCount: number) => {
    let selectCalls = 0;
    const tx = {
      ...txCapGuards(ownedCount),
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
            values: (values: {
              institutionId: string;
              userId: string;
              membershipRole: string;
              status: string;
            }) => ({
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
      createInstitutionWorkspaceForUser(
        "user_at_limit",
        { displayName: "Kampus Baru", institutionType: "company" },
        db,
      ),
    ).rejects.toThrow(InstitutionWorkspaceInputError);

    await createInstitutionWorkspaceForUser(
      "user_at_limit",
      { displayName: "Kampus Baru", institutionType: "company" },
      db,
    ).catch((err: unknown) => {
      expect(err).toBeInstanceOf(InstitutionWorkspaceInputError);
      expect((err as InstitutionWorkspaceInputError).code).toBe(
        "recruiter_institution_limit_reached",
      );
      expect((err as InstitutionWorkspaceInputError).httpStatus).toBe(409);
    });
  });

  it("F7: allows creation when recruiter is one below the limit", async () => {
    const { db } = createDbMockWithOwnerCount(MAX_INSTITUTIONS_PER_RECRUITER - 1);
    await expect(
      createInstitutionWorkspaceForUser(
        "user_below_limit",
        { displayName: "Kampus Baru", institutionType: "company" },
        db,
      ),
    ).resolves.toMatchObject({ ownerMembership: { membershipRole: "institution_owner" } });
  });

  it("F7: count is scoped to the requesting user — different users are independent", async () => {
    const dbA = createDbMockWithOwnerCount(MAX_INSTITUTIONS_PER_RECRUITER).db;
    const dbB = createDbMockWithOwnerCount(0).db;

    await expect(
      createInstitutionWorkspaceForUser(
        "user_A_at_limit",
        { displayName: "Kampus A", institutionType: "company" },
        dbA,
      ),
    ).rejects.toBeInstanceOf(InstitutionWorkspaceInputError);

    await expect(
      createInstitutionWorkspaceForUser(
        "user_B_at_zero",
        { displayName: "Kampus B", institutionType: "company" },
        dbB,
      ),
    ).resolves.toBeDefined();
  });

  // Step 6.5f.1 (Amendment) — the DB display_name NOT NULL constraint was loosened (migration
  // 0031) so personal institutions can store NULL. Full institutions must still get a stored name,
  // now enforced at the service layer via the create-input parser.
  it("Amendment 2: full create rejects an empty / whitespace display name at the service layer", async () => {
    const { db } = createDbMockWithOwnerCount(0);
    await expect(
      createInstitutionWorkspaceForUser(
        "user_1",
        { displayName: "   ", institutionType: "company" },
        db,
      ),
    ).rejects.toMatchObject({ code: "institution_invalid_value" });
  });

  it("Amendment 2: full create rejects a missing display name at the service layer", async () => {
    const { db } = createDbMockWithOwnerCount(0);
    await expect(
      createInstitutionWorkspaceForUser(
        "user_1",
        { slug: "kampus-tanpa-nama", institutionType: "company" },
        db,
      ),
    ).rejects.toMatchObject({ code: "institution_invalid_value" });
  });

  it("retries on slug collision when the postgres error is wrapped under .cause (Drizzle shape)", async () => {
    const { db, attemptedInstitutionSlugs, institutionRows } = createDbMockForCreation({
      slugConflictsBeforeSuccess: 1,
      conflictShape: "wrapped",
    });

    const workspace = await createInstitutionWorkspaceForUser(
      "user_1",
      { displayName: "Universitas Nusantara", institutionType: "university" },
      db,
    );

    expect(attemptedInstitutionSlugs).toEqual(["universitas-nusantara", "universitas-nusantara-2"]);
    expect(institutionRows).toHaveLength(1);
    expect(workspace.slug).toBe("universitas-nusantara-2");
  });
});

// The personal institution lookup and the username-to-slug collision check.
describe("personal institution lookup and the username namespace", () => {
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
      await expect(usernameCollidesWithInstitutionSlug("universitas-indonesia", db)).resolves.toBe(
        true,
      );
    });

    it("returns false when no institution holds the slug", async () => {
      const { db } = makeSlugSyncDb([[]]);
      await expect(usernameCollidesWithInstitutionSlug("bob", db)).resolves.toBe(false);
    });
  });
});

// The settings update takes a name and a slug patch for every kind.
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

  it("applies a slug patch on a personal institution", async () => {
    const { db, captured } = makeSettingsDb([
      [
        ownerRow({
          institutionType: "personal",
          institutionSlug: "ruang-lama",
          institutionDisplayName: "Ruang Lama",
        }),
      ],
      [], // institutionSlugCollidesWithUsername("ruang-baru") → no colliding username
      [], // UPDATE resolve
      [
        ownerRow({
          institutionType: "personal",
          institutionSlug: "ruang-baru",
          institutionDisplayName: "Ruang Lama",
        }),
      ],
    ]);

    const result = await updateInstitutionWorkspaceForOwnerBySlug(
      "user_1",
      "ruang-lama",
      { slug: "ruang-baru" },
      db,
    );

    expect(captured.updateCalls).toBe(1);
    expect(captured.updatedSlug).toBe("ruang-baru");
    expect(result.slug).toBe("ruang-baru");
  });

  it("still applies a slug patch on a full institution", async () => {
    const { db, captured } = makeSettingsDb([
      [
        ownerRow({
          institutionType: null,
          institutionSlug: "kampus-lama",
          institutionDisplayName: "Kampus Lama",
        }),
      ],
      [], // Fix D: institutionSlugCollidesWithUsername("kampus-baru") → no colliding username
      [], // UPDATE resolve
      [
        ownerRow({
          institutionType: null,
          institutionSlug: "kampus-baru",
          institutionDisplayName: "Kampus Lama",
        }),
      ],
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
      [
        ownerRow({
          institutionType: null,
          institutionSlug: "kampus-lama",
          institutionDisplayName: "Kampus Lama",
        }),
      ],
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
      [
        ownerRow({
          institutionType: null,
          institutionSlug: "kampus-lama",
          institutionDisplayName: "Kampus Lama",
        }),
      ],
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
      updateInstitutionWorkspaceForOwnerBySlug(
        "user_1",
        "kampus-lama",
        { slug: "kampus-baru" },
        db,
      ),
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
        ...txCapGuards(options.ownedCount),
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
      createInstitutionWorkspaceForUser(
        "user_1",
        { displayName: "alice", institutionType: "company" },
        db,
      ),
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
      createInstitutionWorkspaceForUser(
        "user_1",
        { displayName: "Universitas Nusantara", institutionType: "university" },
        db,
      ),
    ).resolves.toMatchObject({ slug: "universitas-nusantara" });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects a reserved-word slug before reaching the username probe (ordering preserved)", async () => {
    const { db, transaction } = makeCreateDb({ ownedCount: 0, usernameCollision: true });

    // `personal` is a reserved word; parse rejects it (422) before the Fix-C probe or any insert.
    await expect(
      createInstitutionWorkspaceForUser(
        "user_1",
        { displayName: "Kampus", slug: "personal", institutionType: "company" },
        db,
      ),
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
    const selectResults: unknown[][] = [[{ value: 0 }], [], [], [{ id: "user_target_2" }], []];
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
        ...txCapGuards(0),
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
      { displayName: "Target", institutionType: "company" },
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

// Owner-cap lock (concurrency hardening) — the create-path cap is now re-checked INSIDE the insert
// transaction, behind a per-owner advisory lock. Two concurrent same-owner creates each pass the fast
// pre-check (their snapshots cannot see the other's uncommitted insert under READ COMMITTED); the
// in-transaction re-count under the lock is the true guard. The harness cannot run true parallel
// transactions, so these drive the guard directly: a create whose pre-check passed but whose in-tx
// count is already at the cap must reject with the SAME 409 and write nothing, and distinct owners
// must derive distinct lock keys (so one owner never blocks another).
describe("createInstitutionWorkspaceForUser owner-cap lock", () => {
  const makeSeqNode = (result: unknown[]) => {
    const node: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where", "limit"]) node[m] = () => node;
    node.then = (resolve: (v: unknown) => void) => resolve(result);
    return node;
  };

  // Full create-path mock. db.select #1 = fast pre-check count; #2 = base username probe (none);
  // #3 = Fix-E candidate probe (none). The tx re-counts via txCapGuards(inTxCount) under the lock.
  const makeFullRaceDb = (opts: { preCheckCount: number; inTxCount: number }) => {
    const capturedLockKeys: string[] = [];
    const insertedMemberships: Array<Record<string, unknown>> = [];
    let sel = 0;
    const tx = {
      ...txCapGuards(opts.inTxCount, capturedLockKeys),
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
                  institutionCreatedAt: new Date("2026-07-08T00:00:00.000Z"),
                  institutionUpdatedAt: new Date("2026-07-08T00:00:00.000Z"),
                },
              ],
            }),
          };
        }
        return {
          values: (values: Record<string, unknown>) => {
            insertedMemberships.push(values);
            return {
              returning: async () => [
                {
                  membershipId: "mem_new",
                  membershipRole: values.membershipRole,
                  membershipStatus: values.status,
                  membershipJoinedAt: new Date("2026-07-08T00:00:00.000Z"),
                },
              ],
            };
          },
        };
      }),
    };
    const db = {
      select: vi.fn(() => {
        sel += 1;
        return makeSeqNode(sel === 1 ? [{ value: opts.preCheckCount }] : []);
      }),
      transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Database;
    return { db, capturedLockKeys, insertedMemberships };
  };

  it("the in-transaction guard rejects a racer that passed the pre-check (same 409, nothing written)", async () => {
    // Pre-check sees MAX-1 (passes); a concurrent create commits; the in-tx re-count sees MAX and trips.
    const { db, capturedLockKeys, insertedMemberships } = makeFullRaceDb({
      preCheckCount: MAX_INSTITUTIONS_PER_RECRUITER - 1,
      inTxCount: MAX_INSTITUTIONS_PER_RECRUITER,
    });

    await expect(
      createInstitutionWorkspaceForUser(
        "racer_user",
        { displayName: "Kampus Kilat", institutionType: "company" },
        db,
      ),
    ).rejects.toMatchObject({ code: "recruiter_institution_limit_reached", httpStatus: 409 });

    // Guard fired before any insert committed — no owner membership row written.
    expect(insertedMemberships).toEqual([]);
    // Lock acquired, keyed on the acting owner.
    expect(capturedLockKeys).toEqual(["inst_owner_cap:racer_user"]);
  });

  it("cross-owner independence: two owners' creates acquire distinct advisory-lock keys", async () => {
    const a = makeFullRaceDb({ preCheckCount: 0, inTxCount: 0 });
    const b = makeFullRaceDb({ preCheckCount: 0, inTxCount: 0 });

    await createInstitutionWorkspaceForUser(
      "owner_A",
      { displayName: "Kampus A", institutionType: "company" },
      a.db,
    );
    await createInstitutionWorkspaceForUser(
      "owner_B",
      { displayName: "Kampus B", institutionType: "company" },
      b.db,
    );

    expect(a.capturedLockKeys).toEqual(["inst_owner_cap:owner_A"]);
    expect(b.capturedLockKeys).toEqual(["inst_owner_cap:owner_B"]);
    // Distinct keys → owner A's lock can never block owner B's create.
    expect(a.capturedLockKeys[0]).not.toBe(b.capturedLockKeys[0]);
  });

  it("takes the owner lock after the account guard and before the in-transaction count", async () => {
    const calls: string[] = [];
    const guards = txCapGuards(0);
    const tx = {
      select: vi.fn(() => {
        calls.push("select");
        return guards.select();
      }),
      execute: vi.fn((query?: unknown) => {
        calls.push("lock");
        return guards.execute(query);
      }),
      insert: vi.fn((table: unknown) => {
        calls.push("insert");
        if (table === institutions) {
          return {
            values: (values: { displayName: string; slug: string; status: string }) => ({
              returning: async () => [
                {
                  institutionId: "inst_new",
                  institutionDisplayName: values.displayName,
                  institutionSlug: values.slug,
                  institutionStatus: values.status,
                  institutionCreatedAt: new Date("2026-07-08T00:00:00.000Z"),
                  institutionUpdatedAt: new Date("2026-07-08T00:00:00.000Z"),
                },
              ],
            }),
          };
        }
        return {
          values: (values: Record<string, unknown>) => ({
            returning: async () => [
              {
                membershipId: "mem_new",
                membershipRole: values.membershipRole,
                membershipStatus: values.status,
                membershipJoinedAt: new Date("2026-07-08T00:00:00.000Z"),
              },
            ],
          }),
        };
      }),
    };
    let sel = 0;
    const db = {
      select: vi.fn(() => {
        sel += 1;
        return makeSeqNode(sel === 1 ? [{ value: 0 }] : []);
      }),
      transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    } as unknown as Database;

    await createInstitutionWorkspaceForUser(
      "owner_A",
      { displayName: "Kampus Urut", institutionType: "personal" },
      db,
    );

    expect(calls).toEqual(["select", "lock", "select", "insert", "insert"]);
  });
});
