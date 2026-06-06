// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/auth/email-verification", () => ({
  sendRegistrationVerificationEmail: vi.fn(),
}));

const { claimPendingInvitationsForUser } = vi.hoisted(() => ({
  claimPendingInvitationsForUser: vi.fn().mockResolvedValue({
    institutionInvitationsClaimed: 0,
    teamInvitationsClaimed: 0,
  }),
}));
vi.mock("@/server/invitations/claim-service", () => ({ claimPendingInvitationsForUser }));

import { verifyRegistrationEmailToken } from "@/server/auth/credentials-auth";
import { hashVerificationToken } from "@/server/auth/password";

const RAW_TOKEN = "f".repeat(64);

afterEach(() => vi.clearAllMocks());

// db mock: token lookup select → [tokenRecord]; transaction runs cb(tx) with chainable no-op tx.
const makeDb = (tokenRecord: unknown) => {
  const limit = vi.fn().mockResolvedValue([tokenRecord]);
  const where = vi.fn().mockReturnValue({ limit });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  const select = vi.fn().mockReturnValue({ from });

  const tx = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
  };
  const transaction = vi.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx));
  return { db: { select, transaction }, tx };
};

describe("verifyRegistrationEmailToken — claim-at-signup wiring (Step 6.5e)", () => {
  it("claims pending invitations inside the verification transaction on first verify", async () => {
    const { db, tx } = makeDb({
      id: "tok_1",
      userId: "user_x",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      email: "user@e.com",
      emailVerified: null,
    });

    const result = await verifyRegistrationEmailToken(RAW_TOKEN, db as never);

    expect(result.status).toBe("verified");
    expect(claimPendingInvitationsForUser).toHaveBeenCalledWith(
      "user_x",
      "user@e.com",
      tx,
      expect.any(Date),
    );
  });

  it("does NOT claim for an already-consumed token (no transaction runs)", async () => {
    const { db } = makeDb({
      id: "tok_1",
      userId: "user_x",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: new Date(),
      email: "user@e.com",
      emailVerified: new Date(),
    });

    await verifyRegistrationEmailToken(RAW_TOKEN, db as never);
    expect(claimPendingInvitationsForUser).not.toHaveBeenCalled();
  });
});

// Sanity: the hashing helper the verify path relies on is stable for the raw token shape.
describe("hashVerificationToken", () => {
  it("produces a deterministic hex hash", () => {
    expect(hashVerificationToken(RAW_TOKEN)).toBe(hashVerificationToken(RAW_TOKEN));
  });
});
