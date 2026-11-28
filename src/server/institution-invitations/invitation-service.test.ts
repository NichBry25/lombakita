// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptInstitutionInvitationForUser,
  createInstitutionInvitation,
} from "@/server/institution-invitations/invitation-service";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { enqueueInstitutionInvitationDispatch } = vi.hoisted(() => ({
  enqueueInstitutionInvitationDispatch: vi.fn(),
}));
vi.mock("@/server/async/enqueue", () => ({ enqueueInstitutionInvitationDispatch }));
vi.mock("@/server/host-trust/publish-trust", () => ({
  isHostTrustRemoved: vi.fn(async () => false),
}));

// The live-place read and its locks run against a real database in
// host-promotion-refusal-db.integration.test.ts. Here they are the seam this file drives.
const { lockInstitutionCompetitionsForPlaceCheck, holdsLivePlaceInInstitution } = vi.hoisted(
  () => ({
    lockInstitutionCompetitionsForPlaceCheck: vi.fn(),
    holdsLivePlaceInInstitution: vi.fn(),
  }),
);
vi.mock("@/server/institution-members/live-place", () => ({
  lockInstitutionCompetitionsForPlaceCheck,
  holdsLivePlaceInInstitution,
}));

const { lockInstitutionOwnership } = vi.hoisted(() => ({
  lockInstitutionOwnership: vi.fn(),
}));
vi.mock("@/server/institution-members/owner-membership-lock", () => ({
  lockInstitutionOwnership,
}));

beforeEach(() => {
  lockInstitutionOwnership.mockReset();
  lockInstitutionOwnership.mockResolvedValue(undefined);
  lockInstitutionCompetitionsForPlaceCheck.mockReset();
  lockInstitutionCompetitionsForPlaceCheck.mockResolvedValue(undefined);
  holdsLivePlaceInInstitution.mockReset();
  holdsLivePlaceInInstitution.mockResolvedValue(false);
});

const INVITATION_ID = "inv_1";
const TARGET_USER = "user_1";
const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);

const baseInvitation = (
  overrides: Partial<{
    invitedRole: string;
    status: string;
    targetUserId: string | null;
    expiresAt: Date;
  }> = {},
) => ({
  id: INVITATION_ID,
  institutionId: "inst_1",
  invitedEmail: "user@example.com",
  invitedRole: overrides.invitedRole ?? "institution_staff",
  invitedByUserId: "owner_1",
  status: overrides.status ?? "pending",
  targetUserId: overrides.targetUserId === undefined ? TARGET_USER : overrides.targetUserId,
  expiresAt: overrides.expiresAt ?? FUTURE,
  tokenHash: "hash",
  acceptedAt: null,
  createdAt: new Date(),
});

// Sequential select results feed `limit()` in call order; update().set().where() resolves to [].
//
// The first read in the acceptance transaction is the plain read that decides which competition
// locks to take, answered here by the invitation row the test supplies first. The second is the
// de-identified-account guard, answered here rather than at every call site: `active` unless a test
// passes the second argument. What `.limit` returns is both awaitable and carries the
// `.for("update")` the guard calls.
const makeTx = (
  selectResults: unknown[][],
  deactivatedStatus: "active" | "deactivated" = "active",
) => {
  const [invitationRows = []] = selectResults;
  const results: unknown[][] = [invitationRows, [{ status: deactivatedStatus }], ...selectResults];
  let callIndex = 0;
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      const result = results[callIndex] ?? [];
      callIndex++;
      return {
        for: vi.fn().mockResolvedValue(result),
        then: (onFulfilled: (rows: unknown[]) => unknown) =>
          Promise.resolve(result).then(onFulfilled),
      };
    }),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue([]),
  };
};

const makeDb = (tx: ReturnType<typeof makeTx>) => ({
  transaction: vi.fn().mockImplementation((cb: (tx: unknown) => Promise<void>) => cb(tx)),
});

describe("acceptInstitutionInvitationForUser — session-id match", () => {
  it("accepts when session.user.id === target_user_id (no existing membership)", async () => {
    const tx = makeTx([[baseInvitation()], []]); // invitation, membership-check empty
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["recruiter"],
        makeDb(tx) as never,
      ),
    ).resolves.toBeUndefined();
    expect(tx.insert).toHaveBeenCalled();
  });

  it("returns non-leaking 404 when the caller is NOT the target user", async () => {
    const tx = makeTx([[baseInvitation({ targetUserId: "someone_else" })]]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["recruiter"],
        makeDb(tx) as never,
      ),
    ).rejects.toMatchObject({ code: "invitation_not_found", httpStatus: 404 });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("returns 404 when the invitation does not exist", async () => {
    const tx = makeTx([[]]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["recruiter"],
        makeDb(tx) as never,
      ),
    ).rejects.toMatchObject({ code: "invitation_not_found", httpStatus: 404 });
  });

  it("a pending_claim row (null target) is unacceptable — 404 for everyone", async () => {
    const tx = makeTx([[baseInvitation({ status: "pending_claim", targetUserId: null })]]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["recruiter"],
        makeDb(tx) as never,
      ),
    ).rejects.toMatchObject({ code: "invitation_not_found", httpStatus: 404 });
  });

  it("returns 410 when the invitation has expired", async () => {
    const tx = makeTx([[baseInvitation({ expiresAt: PAST })]]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["recruiter"],
        makeDb(tx) as never,
      ),
    ).rejects.toMatchObject({ code: "invitation_not_actionable", httpStatus: 410 });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("refuses a de-identified account with 409 account_deactivated, before the invitation is read for the accept", async () => {
    // Acceptance hands this account a membership, so a tombstone is refused whole rather than
    // refused at the membership write. The two reads the run made are the plain read that picks the
    // competition locks and the guard's own, asserted by count: the read the accept acts on comes
    // after the guard.
    const tx = makeTx([[baseInvitation()], []], "deactivated");
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["recruiter"],
        makeDb(tx) as never,
      ),
    ).rejects.toMatchObject({ code: "account_deactivated", httpStatus: 409 });
    expect(tx.limit).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe("acceptInstitutionInvitationForUser — a live place in the institution's competitions", () => {
  const acceptAs = (tx: ReturnType<typeof makeTx>) =>
    acceptInstitutionInvitationForUser(
      INVITATION_ID,
      TARGET_USER,
      ["recruiter"],
      makeDb(tx) as never,
    );

  it("takes the competition locks before the account row is locked, for a staff invitation", async () => {
    const tx = makeTx([[baseInvitation({ invitedRole: "institution_staff" })], []]);
    await acceptAs(tx);

    const accountGuardCallOrder = tx.limit.mock.invocationCallOrder[1]!;
    expect(lockInstitutionCompetitionsForPlaceCheck).toHaveBeenCalledTimes(1);
    expect(lockInstitutionCompetitionsForPlaceCheck.mock.calls[0]![1]).toBe("inst_1");
    expect(lockInstitutionCompetitionsForPlaceCheck.mock.invocationCallOrder[0]).toBeLessThan(
      accountGuardCallOrder,
    );
  });

  it("refuses an owner or staff invitation with 409 when the person holds a live place, and writes nothing", async () => {
    holdsLivePlaceInInstitution.mockResolvedValue(true);
    const tx = makeTx([[baseInvitation({ invitedRole: "institution_owner" })], []]);

    await expect(acceptAs(tx)).rejects.toMatchObject({
      code: "member_holds_competition_place",
      httpStatus: 409,
    });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.set).not.toHaveBeenCalled();
  });

  it("neither locks nor reads a place for a member invitation", async () => {
    holdsLivePlaceInInstitution.mockResolvedValue(true);
    const tx = makeTx([[baseInvitation({ invitedRole: "institution_member" })], []]);

    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["candidate"],
        makeDb(tx) as never,
      ),
    ).resolves.toBeUndefined();
    expect(lockInstitutionCompetitionsForPlaceCheck).not.toHaveBeenCalled();
    expect(holdsLivePlaceInInstitution).not.toHaveBeenCalled();
  });

  it("does not take the place check for another user's invitation, so the 404 is unchanged", async () => {
    const tx = makeTx([[baseInvitation({ targetUserId: "someone_else" })]]);

    await expect(acceptAs(tx)).rejects.toMatchObject({
      code: "invitation_not_found",
      httpStatus: 404,
    });
    expect(lockInstitutionCompetitionsForPlaceCheck).not.toHaveBeenCalled();
  });
});

describe("acceptInstitutionInvitationForUser, the institution's ownership lock", () => {
  it("takes the institution's ownership lock first, before the competition locks and before the membership is written", async () => {
    const tx = makeTx([[baseInvitation({ invitedRole: "institution_staff" })], []]);

    await acceptInstitutionInvitationForUser(
      INVITATION_ID,
      TARGET_USER,
      ["recruiter"],
      makeDb(tx) as never,
    );

    expect(lockInstitutionOwnership).toHaveBeenCalledTimes(1);
    expect(lockInstitutionOwnership.mock.calls[0]![1]).toEqual(["inst_1"]);
    expect(lockInstitutionOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      lockInstitutionCompetitionsForPlaceCheck.mock.invocationCallOrder[0]!,
    );
    expect(lockInstitutionCompetitionsForPlaceCheck.mock.invocationCallOrder[0]).toBeLessThan(
      tx.insert.mock.invocationCallOrder[0]!,
    );
  });

  it("takes the ownership lock for a member invitation too, before the membership is written", async () => {
    const tx = makeTx([[baseInvitation({ invitedRole: "institution_member" })], []]);

    await acceptInstitutionInvitationForUser(
      INVITATION_ID,
      TARGET_USER,
      ["candidate"],
      makeDb(tx) as never,
    );

    expect(lockInstitutionOwnership).toHaveBeenCalledTimes(1);
    expect(lockInstitutionOwnership.mock.calls[0]![1]).toEqual(["inst_1"]);
    expect(lockInstitutionOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      tx.insert.mock.invocationCallOrder[0]!,
    );
    expect(lockInstitutionCompetitionsForPlaceCheck).not.toHaveBeenCalled();
  });
});

describe("acceptInstitutionInvitationForUser — CCR-08 verification gate at acceptance", () => {
  it("blocks a candidate-only account from an institution_staff invite", async () => {
    const tx = makeTx([[baseInvitation({ invitedRole: "institution_staff" })]]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["candidate"],
        makeDb(tx) as never,
      ),
    ).rejects.toMatchObject({ code: "invitation_role_verification_required", httpStatus: 403 });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("names the host step as the next step when a candidate-only account takes a staff invitation", async () => {
    const tx = makeTx([[baseInvitation({ invitedRole: "institution_staff" })]]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["candidate"],
        makeDb(tx) as never,
      ),
    ).rejects.toMatchObject({
      code: "invitation_role_verification_required",
      httpStatus: 403,
      redirectTo: "/auth/verify-role?as=recruiter",
    });
  });

  it("blocks a candidate-only account from an institution_owner invite", async () => {
    const tx = makeTx([[baseInvitation({ invitedRole: "institution_owner" })]]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["candidate"],
        makeDb(tx) as never,
      ),
    ).rejects.toMatchObject({ code: "invitation_role_verification_required", httpStatus: 403 });
  });

  it("allows a candidate-only account to accept an institution_member invite", async () => {
    const tx = makeTx([[baseInvitation({ invitedRole: "institution_member" })], []]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["candidate"],
        makeDb(tx) as never,
      ),
    ).resolves.toBeUndefined();
  });

  it("allows a recruiter-verified account to accept an institution_owner invite", async () => {
    const tx = makeTx([[baseInvitation({ invitedRole: "institution_owner" })], []]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["recruiter"],
        makeDb(tx) as never,
      ),
    ).resolves.toBeUndefined();
  });

  // The status was previously omitted from this fixture, which made the assertion pass for the
  // wrong reason: acceptance refused on the row EXISTING rather than on it being active.
  it("blocks acceptance when already an ACTIVE member (409)", async () => {
    const tx = makeTx([[baseInvitation()], [{ id: "mem_1", status: "active" }]]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["recruiter"],
        makeDb(tx) as never,
      ),
    ).rejects.toMatchObject({ code: "invitation_already_member", httpStatus: 409 });
  });
});

// Removal is soft (status='revoked', row retained for the audit trail) and (institution_id,
// user_id) is unique, so a rejoin has to reuse the row. Refusing on existence alone meant a
// removed member could be re-invited — the creation guard filters on 'active' — and could then
// never accept, being told they were already a member when they were not.
describe("acceptInstitutionInvitationForUser — rejoining after removal", () => {
  const membershipWriteFrom = (tx: ReturnType<typeof makeTx>) =>
    tx.set.mock.calls
      .map((call) => call[0] as Record<string, unknown> | undefined)
      .find((payload) => Boolean(payload) && "membershipRole" in (payload as object));

  it("reactivates a revoked membership rather than refusing the rejoin", async () => {
    const tx = makeTx([[baseInvitation()], [{ id: "mem_1", status: "revoked" }]]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["recruiter"],
        makeDb(tx) as never,
      ),
    ).resolves.toBeUndefined();
    // The unique index makes a second row impossible, so the rejoin must be an update.
    expect(tx.insert).not.toHaveBeenCalled();
    expect(membershipWriteFrom(tx)).toMatchObject({
      status: "active",
      membershipRole: "institution_staff",
    });
  });

  it("takes the role from the new invitation, not from the retained row", async () => {
    const tx = makeTx([
      [baseInvitation({ invitedRole: "institution_member" })],
      [{ id: "mem_1", status: "revoked" }],
    ]);
    await expect(
      acceptInstitutionInvitationForUser(
        INVITATION_ID,
        TARGET_USER,
        ["candidate"],
        makeDb(tx) as never,
      ),
    ).resolves.toBeUndefined();
    expect(membershipWriteFrom(tx)).toMatchObject({ membershipRole: "institution_member" });
  });
});

// Queue-based db mock for the non-transactional create path. Every select ends in .limit(1).
const makeCreateDb = (queue: unknown[][], insertReturning: unknown[]) => {
  const insertValues = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(insertReturning),
  });
  const select = vi.fn(() => {
    const result = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.limit = () => Promise.resolve(result);
    return chain;
  });
  return {
    db: { select, insert: vi.fn(() => ({ values: insertValues })) },
    insertValues,
  };
};

const ADMIN_ROW = [
  { institutionId: "inst_1", institutionDisplayName: "Univ", institutionType: null },
];
const PERSONAL_ADMIN_ROW = [
  { institutionId: "inst_p", institutionDisplayName: "Pribadi", institutionType: "personal" },
];
const CREATE_RETURNING = [{ id: "inv_new", invitedEmail: "x@e.com", expiresAt: FUTURE }];

describe("createInstitutionInvitation — resolution + dual-channel enqueue", () => {
  it("email matching a verified account → status pending + target_user_id set", async () => {
    enqueueInstitutionInvitationDispatch.mockResolvedValue(undefined);
    const { db, insertValues } = makeCreateDb(
      [ADMIN_ROW, [{ id: "target_u" }], [], []],
      CREATE_RETURNING,
    );
    await createInstitutionInvitation(
      "admin_1",
      "univ",
      { invitedIdentifier: "x@e.com", invitedRole: "institution_staff" },
      db as never,
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", targetUserId: "target_u" }),
    );
    expect(enqueueInstitutionInvitationDispatch).toHaveBeenCalled();
  });

  it("email with no verified account → status pending_claim + null target", async () => {
    enqueueInstitutionInvitationDispatch.mockResolvedValue(undefined);
    const { db, insertValues } = makeCreateDb([ADMIN_ROW, [], [], []], CREATE_RETURNING);
    await createInstitutionInvitation(
      "admin_1",
      "univ",
      { invitedIdentifier: "nobody@e.com", invitedRole: "institution_member" },
      db as never,
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending_claim", targetUserId: null }),
    );
  });

  it("username that resolves to no account → 404 invitation_recipient_not_found", async () => {
    const { db } = makeCreateDb([ADMIN_ROW, []], CREATE_RETURNING);
    await expect(
      createInstitutionInvitation(
        "admin_1",
        "univ",
        { invitedIdentifier: "ghost_user", invitedRole: "institution_staff" },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "invitation_recipient_not_found", httpStatus: 404 });
  });

  it("400 invitation_invalid_identifier for a malformed identifier", async () => {
    const { db } = makeCreateDb([ADMIN_ROW], CREATE_RETURNING);
    await expect(
      createInstitutionInvitation(
        "admin_1",
        "univ",
        { invitedIdentifier: "bad@", invitedRole: "institution_staff" },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "invitation_invalid_identifier", httpStatus: 400 });
  });

  it("lets the owner of a personal workspace invite staff", async () => {
    enqueueInstitutionInvitationDispatch.mockResolvedValue(undefined);
    const { db, insertValues } = makeCreateDb(
      [PERSONAL_ADMIN_ROW, [{ id: "target_u" }], [], []],
      CREATE_RETURNING,
    );

    const result = await createInstitutionInvitation(
      "owner_1",
      "pribadi",
      { invitedIdentifier: "x@e.com", invitedRole: "institution_staff" },
      db as never,
    );

    expect(result).toEqual(CREATE_RETURNING[0]);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        institutionId: "inst_p",
        invitedRole: "institution_staff",
        status: "pending",
        targetUserId: "target_u",
      }),
    );
    expect(enqueueInstitutionInvitationDispatch).toHaveBeenCalled();
  });

  it("dual-channel: invite still succeeds when the dispatch enqueue throws", async () => {
    enqueueInstitutionInvitationDispatch.mockRejectedValueOnce(new Error("redis down"));
    const { db } = makeCreateDb([ADMIN_ROW, [{ id: "target_u" }], [], []], CREATE_RETURNING);
    const result = await createInstitutionInvitation(
      "admin_1",
      "univ",
      { invitedIdentifier: "x@e.com", invitedRole: "institution_staff" },
      db as never,
    );
    expect(result.id).toBe("inv_new");
  });
});
