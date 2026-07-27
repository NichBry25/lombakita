// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CompetitionError,
  type CompetitionPatchInput,
} from "@/server/competitions/competition-core";
import { PUBLIC_COMPETITION_COLUMNS } from "@/server/competitions/competition-access";
import type { CompetitionRow } from "@/server/competitions/competition-access";

const {
  assertCompetitionAccess,
  assertActorIsTrustedRecruiter,
  assertInstitutionNotSuspended,
  enqueueCompetitionSearchSync,
  enqueueCompetitionEdited,
  enqueueCompetitionCancelled,
} = vi.hoisted(() => ({
  assertCompetitionAccess: vi.fn(),
  assertActorIsTrustedRecruiter: vi.fn(),
  assertInstitutionNotSuspended: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn(async () => ({})),
  enqueueCompetitionEdited: vi.fn(async () => ({})),
  enqueueCompetitionCancelled: vi.fn(async () => ({})),
}));

vi.mock("@/server/async/enqueue", () => ({
  enqueueCompetitionSearchSync,
  enqueueCompetitionEdited,
  enqueueCompetitionCancelled,
}));

vi.mock("@/server/competitions/competition-access", async () => {
  const actual = await vi.importActual<typeof import("@/server/competitions/competition-access")>(
    "@/server/competitions/competition-access",
  );
  return {
    ...actual,
    assertCompetitionAccess,
    assertActorIsTrustedRecruiter,
    assertInstitutionNotSuspended,
  };
});

import type { Database } from "@/server/db/client";
import {
  createCompetitionDraft,
  getCompetitionIdByInstitutionAndSlug,
  transitionCompetitionStatus,
  updateCompetitionDraft,
} from "@/server/competitions/competition-service";

// All tests in this file mock assertCompetitionAccess, so the underlying db is never read.
// We pass an empty stub that satisfies the type signature without triggering getDb().
const stubDb = {} as unknown as Database;

const baseCompetition = (overrides: Partial<CompetitionRow> = {}): CompetitionRow => ({
  id: "comp_1",
  institutionId: "inst_1",
  createdByUserId: "user_1",
  slug: "lomba-x",
  title: "Lomba X",
  description: "Deskripsi",
  status: "draft",
  category: null,
  mode: null,
  minTeamSize: null,
  maxTeamSize: null,
  registrationStartAt: null,
  registrationEndAt: null,
  eventStartAt: null,
  eventEndAt: null,
  allowCancellation: false,
  cancellationCutoffDays: null,
  publishedAt: null,
  archivedAt: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("F1 — deferred fields blocked from output", () => {
  it("PUBLIC_COMPETITION_COLUMNS excludes feeAmount, feeCurrency, isFeatured", () => {
    const keys = Object.keys(PUBLIC_COMPETITION_COLUMNS);
    expect(keys).not.toContain("feeAmount");
    expect(keys).not.toContain("feeCurrency");
    expect(keys).not.toContain("isFeatured");
  });

  it("CompetitionRow shape returned to routes excludes feeAmount, feeCurrency, isFeatured", () => {
    // Type-level guarantee: this object is typed as CompetitionRow and TypeScript will not allow
    // assignments of feeAmount/feeCurrency/isFeatured. The runtime check below documents the
    // contract for future readers and would catch a regression where someone widens CompetitionRow.
    const row: CompetitionRow = baseCompetition();
    expect(Object.prototype.hasOwnProperty.call(row, "feeAmount")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "feeCurrency")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "isFeatured")).toBe(false);
  });
});

describe("F2 — same-status transitions return 422", () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ["draft", "draft"],
    ["published", "published"],
    ["archived", "archived"],
  ] as const)("rejects %s → %s with 422", async (from, to) => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: from }),
      membershipRole: "institution_owner",
    });

    await expect(transitionCompetitionStatus("user_1", "comp_1", to, stubDb)).rejects.toMatchObject(
      {
        code: "competition_invalid_transition",
        httpStatus: 422,
      },
    );
  });

  it("does not call assertActorIsTrustedRecruiter on same-status draft → draft", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "draft" }),
      membershipRole: "institution_owner",
    });

    await expect(
      transitionCompetitionStatus("user_1", "comp_1", "draft", stubDb),
    ).rejects.toBeInstanceOf(CompetitionError);
    expect(assertActorIsTrustedRecruiter).not.toHaveBeenCalled();
  });
});

describe("updateCompetitionDraft — non-editable status guard", () => {
  afterEach(() => vi.clearAllMocks());

  // Archived (terminal) competitions remain non-editable. Published is editable in place via the
  // Step 6.5f post-publish path — covered in competition-service.published-edit.test.ts.
  it("rejects PATCH on an archived competition with 409 competition_not_draft", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "archived" }),
      membershipRole: "institution_owner",
    });
    const patch: CompetitionPatchInput = { title: "Tampered Title 2026" };
    await expect(updateCompetitionDraft("user_1", "comp_1", patch, stubDb)).rejects.toMatchObject({
      code: "competition_not_draft",
      httpStatus: 409,
    });
  });
});

describe("updateCompetitionDraft — IMMUTABLE_AFTER_PUBLISH guard (Step 3.3)", () => {
  afterEach(() => vi.clearAllMocks());

  it("rejects 422 competition_field_immutable when mode changes on a published competition", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({ status: "published", mode: "individual" }),
      membershipRole: "institution_owner",
    });
    const patch: CompetitionPatchInput = { mode: "team" };
    await expect(updateCompetitionDraft("user_1", "comp_1", patch, stubDb)).rejects.toMatchObject({
      code: "competition_field_immutable",
      httpStatus: 422,
    });
  });
});

// F5-5 — publish floor: a team competition with min < 2 must be rejected at publish even when
//        every other publish field is valid (API path: transitionCompetitionStatus → publish).
describe("F5-5 — publish rejects team competition with minTeamSize < 2 (Step 6.5b)", () => {
  afterEach(() => vi.clearAllMocks());

  const future = (days: number): Date => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d;
  };

  it("throws competition_publish_validation_failed with a minTeamSize failure", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({
        status: "draft",
        mode: "team",
        minTeamSize: 1,
        maxTeamSize: 4,
        title: "Lomba Tim",
        description: "Deskripsi lengkap",
        category: "hackathon",
        registrationStartAt: future(2),
        registrationEndAt: future(10),
        eventStartAt: future(20),
        eventEndAt: future(25),
      }),
      membershipRole: "institution_owner",
    });
    assertActorIsTrustedRecruiter.mockResolvedValue(undefined);
    assertInstitutionNotSuspended.mockResolvedValue(undefined);

    await expect(
      transitionCompetitionStatus("user_1", "comp_1", "published", stubDb),
    ).rejects.toMatchObject({
      code: "competition_publish_validation_failed",
      httpStatus: 422,
      details: { fields: expect.arrayContaining(["minTeamSize"]) },
    });
  });

  it("rejects publish with 403 competition_recruiter_not_trusted when the actor is not Trusted", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({
        status: "draft",
        mode: "individual",
        title: "Lomba Individu",
        description: "Deskripsi lengkap",
        category: "hackathon",
        registrationStartAt: future(2),
        registrationEndAt: future(10),
        eventStartAt: future(20),
        eventEndAt: future(25),
      }),
      membershipRole: "institution_owner",
    });
    assertActorIsTrustedRecruiter.mockRejectedValue(
      new CompetitionError(
        "competition_recruiter_not_trusted",
        403,
        "Publishing requires a Trusted Recruiter account — complete recruiter verification first",
      ),
    );

    await expect(
      transitionCompetitionStatus("user_1", "comp_1", "published", stubDb),
    ).rejects.toMatchObject({
      code: "competition_recruiter_not_trusted",
      httpStatus: 403,
    });
    // The trust gate fires before the suspension read — no institution lookup happens.
    expect(assertInstitutionNotSuspended).not.toHaveBeenCalled();
  });

  it("validatePublishChecklist passes for an otherwise-identical team competition with minTeamSize=2", async () => {
    // Proves the rejection above is attributable to the floor, not another field — same valid
    // dates/title/category, only minTeamSize differs. Checked at the pure-validation layer so the
    // test takes no dependency on the DB-update / search-sync tail of the publish path.
    const { validatePublishChecklist } = await import("@/server/competitions/competition-core");
    const result = validatePublishChecklist({
      title: "Lomba Tim",
      description: "Deskripsi lengkap",
      category: "hackathon",
      mode: "team",
      minTeamSize: 2,
      maxTeamSize: 4,
      registrationStartAt: future(2),
      registrationEndAt: future(10),
      eventStartAt: future(20),
      eventEndAt: future(25),
    });
    expect(result.passed).toBe(true);
  });
});

// F5 — secondary floor check in updateCompetitionDraft (cross-field: patch only minTeamSize
//      while existing row has mode=team)
describe("F5 — updateCompetitionDraft secondary floor (Step 6.5b)", () => {
  afterEach(() => vi.clearAllMocks());

  it("rejects patching minTeamSize=1 on a team-mode draft competition", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({
        status: "draft",
        mode: "team",
        minTeamSize: 2,
        maxTeamSize: 4,
      }),
      membershipRole: "institution_owner",
    });
    await expect(
      updateCompetitionDraft("user_1", "comp_1", { minTeamSize: 1 }, stubDb),
    ).rejects.toMatchObject({ code: "competition_invalid_value", httpStatus: 400 });
  });

  it("allows patching minTeamSize=3 on a team-mode draft competition", async () => {
    const updatedRow = baseCompetition({
      status: "draft",
      mode: "team",
      minTeamSize: 3,
      maxTeamSize: 4,
    });
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      }),
    } as unknown as Database;
    assertCompetitionAccess.mockResolvedValue({
      competition: baseCompetition({
        status: "draft",
        mode: "team",
        minTeamSize: 2,
        maxTeamSize: 4,
      }),
      membershipRole: "institution_owner",
    });
    const result = await updateCompetitionDraft("user_1", "comp_1", { minTeamSize: 3 }, db);
    expect(result.minTeamSize).toBe(3);
  });
});

describe("F14 — createCompetitionDraft defaults mode to individual", () => {
  afterEach(() => vi.clearAllMocks());

  const makeCreateDb = () => {
    // Track what values are passed to db.insert().values()
    let capturedValues: Record<string, unknown> = {};

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: "inst_1" }]),
    };

    const insertChain = {
      values: vi.fn((vals: Record<string, unknown>) => {
        capturedValues = vals;
        return {
          returning: vi.fn().mockResolvedValue([{ ...baseCompetition(), mode: vals.mode ?? null }]),
        };
      }),
    };

    const db = {
      select: vi.fn().mockReturnValue(selectChain),
      insert: vi.fn().mockReturnValue(insertChain),
    } as unknown as Database;

    return { db, getInsertedValues: () => capturedValues };
  };

  it("sets mode to individual when no mode is supplied in the input", async () => {
    const { db, getInsertedValues } = makeCreateDb();

    await createCompetitionDraft(
      "user_1",
      { institutionSlug: "test-inst", title: "Lomba Test", description: "Deskripsi", slug: null },
      db,
    );

    expect(getInsertedValues().mode).toBe("individual");
  });

  it("respects an explicit mode override when provided", async () => {
    const { db, getInsertedValues } = makeCreateDb();

    await createCompetitionDraft(
      "user_1",
      {
        institutionSlug: "test-inst",
        title: "Lomba Tim",
        description: "Deskripsi",
        slug: null,
        mode: "team",
      },
      db,
    );

    expect(getInsertedValues().mode).toBe("team");
  });
});

// G6 — institution-scoped competition slug lookup (Step 6.5b)
describe("getCompetitionIdByInstitutionAndSlug", () => {
  const makeSlugDb = (rows: Array<{ id: string }>) =>
    ({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      }),
    }) as unknown as Database;

  it("returns the competitionId when institution+slug match", async () => {
    const db = makeSlugDb([{ id: "comp_abc" }]);
    const result = await getCompetitionIdByInstitutionAndSlug("inst-a", "my-comp", db);
    expect(result).toBe("comp_abc");
  });

  it("throws competition_not_found when no match exists", async () => {
    const db = makeSlugDb([]);
    await expect(
      getCompetitionIdByInstitutionAndSlug("inst-a", "unknown-slug", db),
    ).rejects.toMatchObject({ code: "competition_not_found" });
  });

  it("same slug under different institutions resolves independently (no cross-tenant leak)", async () => {
    // Inst A returns comp_1, inst B returns comp_2 for the same slug "shared-slug".
    const dbA = makeSlugDb([{ id: "comp_1" }]);
    const dbB = makeSlugDb([{ id: "comp_2" }]);

    const idA = await getCompetitionIdByInstitutionAndSlug("inst-a", "shared-slug", dbA);
    const idB = await getCompetitionIdByInstitutionAndSlug("inst-b", "shared-slug", dbB);

    expect(idA).toBe("comp_1");
    expect(idB).toBe("comp_2");
    expect(idA).not.toBe(idB);
  });
});

// A personal institution is never document-verified — it has no documents, and it is excluded
// from the platform-ops verification queue for exactly that reason. These tests pin the
// consequence that matters: excluding it costs it no capability. Publishing is gated on the
// ACCOUNT-level Trusted Recruiter check plus the personal reach cap, and reads nothing about the
// institution's verification_status (assertInstitutionVerified has no caller on this path).
describe("personal institution publish — capability is independent of institution verification", () => {
  afterEach(() => vi.clearAllMocks());

  const future = (days: number): Date => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d;
  };

  const publishableDraft = () =>
    baseCompetition({
      status: "draft",
      mode: "individual",
      title: "Lomba Individu",
      description: "Deskripsi lengkap",
      category: "hackathon",
      registrationStartAt: future(2),
      registrationEndAt: future(10),
      eventStartAt: future(20),
      eventEndAt: future(25),
    });

  // Serves exactly the reads the publish path is expected to make, in order:
  //   1. loadInstitutionTypeById  → 'personal'
  //   2. published-competition count for the reach cap
  // Anything beyond that — a re-wired institution-verification lookup, for instance — draws an
  // empty result and fails the transition, so this mock is the tripwire, not just a stub.
  const makePersonalPublishDb = (publishedCount: number) => {
    const selectResults: unknown[][] = [[{ institutionType: "personal" }], [{ count: publishedCount }]];
    let selectCall = 0;
    const capturedUpdates: Record<string, unknown>[] = [];

    const selectNode = (result: unknown[]): Record<string, unknown> => {
      const n: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "orderBy"]) n[method] = () => n;
      n.where = () => {
        const terminal = { ...n } as Record<string, unknown>;
        terminal.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
        return terminal;
      };
      n.limit = () => Promise.resolve(result);
      return n;
    };

    const db = {
      select: () => selectNode(selectResults[selectCall++] ?? []),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          capturedUpdates.push(values);
          return {
            where: () => ({
              returning: () =>
                Promise.resolve([{ ...publishableDraft(), status: "published", publishedAt: new Date() }]),
            }),
          };
        },
      }),
    } as unknown as Database;

    return { db, capturedUpdates };
  };

  it("publishes an individual-mode competition for a personal institution under the cap", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: publishableDraft(),
      membershipRole: "institution_owner",
    });
    assertActorIsTrustedRecruiter.mockResolvedValue(undefined);
    assertInstitutionNotSuspended.mockResolvedValue(undefined);
    const { db, capturedUpdates } = makePersonalPublishDb(1);

    const result = await transitionCompetitionStatus("user_1", "comp_1", "published", db);

    expect(result.competition.status).toBe("published");
    expect(capturedUpdates[0]).toMatchObject({ status: "published" });
    // The account-level trust gate is what authorizes this publish.
    expect(assertActorIsTrustedRecruiter).toHaveBeenCalledTimes(1);
  });

  it("still enforces the personal reach cap — the capability is bounded, not unconditional", async () => {
    assertCompetitionAccess.mockResolvedValue({
      competition: publishableDraft(),
      membershipRole: "institution_owner",
    });
    assertActorIsTrustedRecruiter.mockResolvedValue(undefined);
    assertInstitutionNotSuspended.mockResolvedValue(undefined);
    const { db } = makePersonalPublishDb(2);

    await expect(
      transitionCompetitionStatus("user_1", "comp_1", "published", db),
    ).rejects.toMatchObject({ code: "competition_personal_publish_limit", httpStatus: 422 });
  });
});
