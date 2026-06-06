// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { claimPendingInvitationsForUser } from "@/server/invitations/claim-service";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// update().set().where().returning() resolves to the next queued row set (institution then team).
const makeDb = (institutionRows: unknown[], teamRows: unknown[]) => {
  let call = 0;
  const returning = vi.fn().mockImplementation(() => {
    const rows = call === 0 ? institutionRows : teamRows;
    call++;
    return Promise.resolve(rows);
  });
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { update, set, where, returning };
};

describe("claimPendingInvitationsForUser", () => {
  it("returns the count of claimed rows across BOTH invitation systems", async () => {
    const db = makeDb([{ id: "inst_1" }, { id: "inst_2" }], [{ id: "team_1" }]);
    const result = await claimPendingInvitationsForUser("user_1", "Claim@Example.com", db as never);
    expect(result).toEqual({ institutionInvitationsClaimed: 2, teamInvitationsClaimed: 1 });
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  it("returns zero counts when nothing matches (no rows claimed)", async () => {
    const db = makeDb([], []);
    const result = await claimPendingInvitationsForUser("user_1", "nobody@example.com", db as never);
    expect(result).toEqual({ institutionInvitationsClaimed: 0, teamInvitationsClaimed: 0 });
  });

  it("attaches the new user id when claiming", async () => {
    const db = makeDb([{ id: "inst_1" }], []);
    await claimPendingInvitationsForUser("new_user", "claim@example.com", db as never);
    expect(db.set).toHaveBeenCalledWith({ targetUserId: "new_user", status: "pending" });
  });
});
