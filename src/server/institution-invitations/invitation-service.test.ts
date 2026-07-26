// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
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
const makeTx = (selectResults: unknown[][]) => {
  let callIndex = 0;
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      const result = selectResults[callIndex] ?? [];
      callIndex++;
      return Promise.resolve(result);
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

  it("blocks acceptance when already a member (409)", async () => {
    const tx = makeTx([[baseInvitation()], [{ id: "mem_1" }]]);
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

  it("Step 6.5f.1: a personal institution cannot invite — 403 invitation_personal_institution", async () => {
    const { db, insertValues } = makeCreateDb([PERSONAL_ADMIN_ROW], CREATE_RETURNING);
    await expect(
      createInstitutionInvitation(
        "owner_1",
        "pribadi",
        { invitedIdentifier: "x@e.com", invitedRole: "institution_staff" },
        db as never,
      ),
    ).rejects.toMatchObject({ code: "invitation_personal_institution", httpStatus: 403 });
    expect(insertValues).not.toHaveBeenCalled();
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
