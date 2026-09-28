// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  reinstateInstitution,
  suspendInstitution,
  suspendUser,
  unsuspendUser,
} from "./moderation-service";
import { ModerationError } from "./moderation-core";
import type { Database } from "@/server/db/client";

// Minimal db mock: a single SELECT (chain ending in .limit) plus a transaction whose tx exposes
// select()/update()/insert(). The audit insert and the update are recorded for assertions.
//
// `txRows` is what a SELECT issued through the transaction handle resolves to — the deactivated
// guard and the active-owner count both read through it. The chain is awaited with and without a
// trailing `.limit`, so the object `.where` returns is both a promise and carries one.
const makeDb = (
  selectRow: Record<string, unknown> | null,
  txRows: Array<Record<string, unknown>> = [],
) => {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];

  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(txRows),
          then: (onFulfilled: (rows: unknown[]) => unknown) =>
            Promise.resolve(txRows).then(onFulfilled),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn((vals: Record<string, unknown>) => {
        updated.push(vals);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn((vals: Record<string, unknown>) => {
        inserted.push(vals);
        return Promise.resolve(undefined);
      }),
    }),
  };

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(selectRow ? [selectRow] : []),
        }),
      }),
    }),
    transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Database;

  return { db, inserted, updated };
};

const expectModerationError = async (p: Promise<unknown>, code: string, status: number) => {
  await expect(p).rejects.toMatchObject({ code, status });
};

beforeEach(() => vi.clearAllMocks());

describe("suspendUser", () => {
  it("rejects empty reason with 400 reason_required", async () => {
    const { db } = makeDb({ id: "u1", role: "candidate", suspendedAt: null });
    await expectModerationError(suspendUser("ops1", "u1", "   ", db), "reason_required", 400);
  });

  it("rejects a platform_ops target with 403 cannot_suspend_platform_ops", async () => {
    const { db } = makeDb({ id: "u1", role: "platform_ops", suspendedAt: null });
    await expectModerationError(
      suspendUser("ops1", "u1", "abuse", db),
      "cannot_suspend_platform_ops",
      403,
    );
  });

  it("rejects a finance_ops target with 403 cannot_suspend_platform_ops", async () => {
    const { db } = makeDb({ id: "u1", role: "finance_ops", suspendedAt: null });
    await expectModerationError(
      suspendUser("ops1", "u1", "abuse", db),
      "cannot_suspend_platform_ops",
      403,
    );
  });

  it("rejects an already-suspended user with 409 user_already_suspended", async () => {
    const { db } = makeDb({ id: "u1", role: "candidate", suspendedAt: new Date() });
    await expectModerationError(
      suspendUser("ops1", "u1", "abuse", db),
      "user_already_suspended",
      409,
    );
  });

  it("returns 404 user_not_found when target does not exist", async () => {
    const { db } = makeDb(null);
    await expectModerationError(suspendUser("ops1", "missing", "abuse", db), "user_not_found", 404);
  });

  it("suspends and writes a user.suspended audit row in the same transaction", async () => {
    const { db, inserted, updated } = makeDb({ id: "u1", role: "candidate", suspendedAt: null });
    const res = await suspendUser("ops1", "u1", "abuse", db);
    expect(res.suspendedAt).not.toBeNull();
    expect(updated[0]).toMatchObject({ suspensionReason: "abuse" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      actorUserId: "ops1",
      targetUserId: "u1",
      eventType: "user.suspended",
      reason: "abuse",
    });
  });
});

describe("unsuspendUser", () => {
  it("rejects a non-suspended user with 409 user_not_suspended", async () => {
    const { db } = makeDb({ id: "u1", suspendedAt: null });
    await expectModerationError(unsuspendUser("ops1", "u1", "ok", db), "user_not_suspended", 409);
  });

  it("clears suspension and writes user.unsuspended audit row", async () => {
    const { db, inserted, updated } = makeDb({ id: "u1", suspendedAt: new Date() });
    const res = await unsuspendUser("ops1", "u1", "appeal granted", db);
    expect(res.suspendedAt).toBeNull();
    expect(updated[0]).toMatchObject({ suspendedAt: null, suspensionReason: null });
    expect(inserted[0]).toMatchObject({ eventType: "user.unsuspended", reason: "appeal granted" });
  });

  it("refuses a de-identified target with 409 account_deactivated", async () => {
    // A de-identified account carries suspended_at NULL, so it never reaches the not-suspended
    // refusal above and would otherwise be unsuspended: a write to a row whose data is gone.
    const { db, inserted, updated } = makeDb({ id: "u1", suspendedAt: new Date() }, [
      { status: "deactivated" },
    ]);

    await expectModerationError(
      unsuspendUser("ops1", "u1", "appeal granted", db),
      "account_deactivated",
      409,
    );

    expect(updated).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });
});

describe("suspendInstitution", () => {
  it("rejects an already-suspended institution with 409", async () => {
    const { db } = makeDb({ id: "i1", suspendedAt: new Date() });
    await expectModerationError(
      suspendInstitution("ops1", "i1", "policy", db),
      "institution_already_suspended",
      409,
    );
  });

  it("suspends and writes institution.suspended audit row", async () => {
    const { db, inserted } = makeDb({ id: "i1", suspendedAt: null });
    await suspendInstitution("ops1", "i1", "policy", db);
    expect(inserted[0]).toMatchObject({
      targetInstitutionId: "i1",
      eventType: "institution.suspended",
    });
  });
});

describe("reinstateInstitution", () => {
  it("rejects a non-suspended institution with 409", async () => {
    const { db } = makeDb({ id: "i1", suspendedAt: null });
    await expectModerationError(
      reinstateInstitution("ops1", "i1", "ok", db),
      "institution_not_suspended",
      409,
    );
  });

  it("reinstates and writes institution.reinstated audit row", async () => {
    const { db, inserted } = makeDb({ id: "i1", suspendedAt: new Date() }, [{ total: 1 }]);
    await reinstateInstitution("ops1", "i1", "resolved", db);
    expect(inserted[0]).toMatchObject({ eventType: "institution.reinstated" });
  });

  it("refuses with 409 institution_has_no_owner when no active owner remains", async () => {
    const { db, inserted, updated } = makeDb({ id: "i1", suspendedAt: new Date() }, [{ total: 0 }]);

    await expectModerationError(
      reinstateInstitution("ops1", "i1", "resolved", db),
      "institution_has_no_owner",
      409,
    );

    expect(updated).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });
});

describe("ModerationError shape", () => {
  it("carries code + status", () => {
    const e = new ModerationError("reason_required", 400, "x");
    expect(e.code).toBe("reason_required");
    expect(e.status).toBe(400);
  });
});
