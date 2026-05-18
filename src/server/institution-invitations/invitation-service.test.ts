// @vitest-environment node

import { createHash } from "crypto";
import { describe, expect, it, vi } from "vitest";
import { acceptInvitation } from "@/server/institution-invitations/invitation-service";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/institution-invitations/invitation-email", () => ({
  sendInstitutionInvitationEmail: vi.fn(),
}));

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

const RAW_TOKEN = "a".repeat(64);
const TOKEN_HASH = hashToken(RAW_TOKEN);
const FUTURE = new Date(Date.now() + 86_400_000);

const baseInvitation = (invitedRole: string) => ({
  id: "inv_1",
  institutionId: "inst_1",
  invitedEmail: "user@example.com",
  invitedRole,
  invitedByUserId: "owner_1",
  status: "pending",
  expiresAt: FUTURE,
  tokenHash: TOKEN_HASH,
  createdAt: new Date(),
  updatedAt: new Date(),
  acceptedAt: null,
  declinedAt: null,
});

const makeTx = (selectResults: unknown[][]) => {
  let callIndex = 0;
  const tx = {
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
  return tx;
};

const makeDb = (tx: ReturnType<typeof makeTx>) => ({
  transaction: vi.fn().mockImplementation((cb: (tx: unknown) => Promise<void>) => cb(tx)),
});

describe("CCR-08 — acceptInvitation verification gate", () => {
  it("rejects a candidate-only account accepting an institution_staff invite", async () => {
    const invitation = baseInvitation("institution_staff");
    const tx = makeTx([
      [invitation], // invitation lookup
      [{ candidateVerifiedAt: new Date(), recruiterVerifiedAt: null }], // user lookup
    ]);
    const db = makeDb(tx);

    await expect(
      acceptInvitation(RAW_TOKEN, "user_1", db as never),
    ).rejects.toMatchObject({
      code: "invitation_role_verification_required",
      httpStatus: 403,
    });
  });

  it("accepts a candidate-only account for an institution_member invite", async () => {
    const invitation = baseInvitation("institution_member");
    const tx = makeTx([
      [invitation], // invitation lookup
      [{ candidateVerifiedAt: new Date(), recruiterVerifiedAt: null }], // user lookup
      [], // existing membership check (none found)
    ]);
    const db = makeDb(tx);

    await expect(
      acceptInvitation(RAW_TOKEN, "user_1", db as never),
    ).resolves.toBeUndefined();
  });
});
