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
import { OperatorActorError } from "@/server/platform-ops/operator-actor";

// Minimal db mock: a single SELECT (chain ending in .limit) plus a transaction whose tx exposes
// select()/update()/insert(). The audit insert and the update are recorded for assertions.
//
// `txRows` is what a SELECT issued through the transaction handle resolves to — the deactivated
// guard and the active-owner count both read through it. The chain is awaited with and without a
// trailing `.limit`, so the object `.where` returns is both a promise and carries one.
const makeDb = (
  selectRow: Record<string, unknown> | null,
  txRows: Array<Record<string, unknown>> = [],
  actorRow: Record<string, unknown> | null = {
    id: "ops1",
    role: "platform_ops",
    suspendedAt: null,
  },
  changedRows: Array<{ id: string }> = [{ id: "i1" }],
  rereadTarget: Record<string, unknown> | null = selectRow,
) => {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];

  const ownerReads = vi.fn();
  let targetReads = 0;
  const tx = {
    execute: vi.fn().mockResolvedValue([]),
    select: vi.fn((fields: Record<string, unknown>) => {
      let rows: Array<Record<string, unknown>>;
      if (fields.role) {
        rows = actorRow ? [actorRow] : [];
      } else if (fields.total) {
        ownerReads();
        rows = txRows;
      } else if (fields.status) {
        rows = txRows;
      } else {
        const target = targetReads++ === 0 ? selectRow : rereadTarget;
        rows = target ? [target] : [];
      }
      const selected = Promise.resolve(rows);
      const limited = Object.assign(selected, { for: vi.fn().mockResolvedValue(rows) });
      const filtered = Object.assign(selected, { limit: vi.fn().mockReturnValue(limited) });
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(filtered) }) };
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn((vals: Record<string, unknown>) => {
        updated.push(vals);
        const result = Object.assign(Promise.resolve(undefined), {
          returning: vi.fn().mockResolvedValue(changedRows),
        });
        return { where: vi.fn().mockReturnValue(result) };
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

  return { db, inserted, updated, tx, ownerReads };
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

  it("takes the institution's owner-membership lock before it counts owners", async () => {
    const { db, tx, ownerReads } = makeDb({ id: "i1", suspendedAt: new Date() }, [{ total: 1 }]);

    await reinstateInstitution("ops1", "i1", "resolved", db);

    // Invocation order, not a call count: the count is the read the lock exists to serialize, so a
    // lock taken after it serializes nothing.
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(
      ownerReads.mock.invocationCallOrder[0]!,
    );
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

const moderationActions = [
  { name: "suspendUser", service: suspendUser, suspended: false, user: true },
  { name: "unsuspendUser", service: unsuspendUser, suspended: true, user: true },
  { name: "suspendInstitution", service: suspendInstitution, suspended: false, user: false },
  { name: "reinstateInstitution", service: reinstateInstitution, suspended: true, user: false },
];

const invalidActors = [
  { label: "missing", row: null, code: "operator_actor_not_found" },
  {
    label: "candidate",
    row: { id: "candidate", role: "candidate", suspendedAt: null },
    code: "operator_actor_not_platform_ops",
  },
  {
    label: "suspended operator",
    row: { id: "ops1", role: "platform_ops", suspendedAt: new Date() },
    code: "operator_actor_suspended",
  },
];

describe.each(moderationActions)("$name operator integrity", (action) => {
  it.each(invalidActors)("refuses a $label actor before any write", async ({ row, code }) => {
    const target = {
      id: "target",
      role: "candidate",
      suspendedAt: action.suspended ? new Date() : null,
    };
    const { db, inserted, updated } = makeDb(target, [{ total: 1 }], row);
    const refusal = await action
      .service("claimed-actor", "target", "reason", db)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({ code, status: 403 });
    expect(updated).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it("writes exactly one audit row naming the database actor", async () => {
    const target = {
      id: "target",
      role: "candidate",
      suspendedAt: action.suspended ? new Date() : null,
    };
    const actor = { id: "database-actor", role: "platform_ops", suspendedAt: null };
    const { db, inserted, updated } = makeDb(target, [{ total: 1 }], actor);
    await action.service("claimed-actor", "target", " reason ", db);
    expect(updated).toHaveLength(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ actorUserId: "database-actor", reason: "reason" });
  });

  it("refuses invalid actor before target guards", async () => {
    const target = action.user
      ? { id: "target", role: "candidate", suspendedAt: action.suspended ? new Date() : null }
      : null;
    const actor = { id: "candidate", role: "candidate", suspendedAt: null };
    const { db } = makeDb(target, [{ status: "deactivated" }], actor);
    const refusal = await action
      .service("candidate", "target", "reason", db)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({ code: "operator_actor_not_platform_ops", status: 403 });
  });

  it("validates an empty reason before any database read", async () => {
    const { db, tx } = makeDb(null);
    await expect(action.service("ops1", "target", " ", db)).rejects.toMatchObject({
      code: "reason_required",
      status: 400,
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
  });
});

describe.each([
  {
    name: "suspendInstitution",
    service: suspendInstitution,
    suspended: false,
    conflictCode: "institution_already_suspended",
    conflictMessage: "Institution is already suspended",
  },
  {
    name: "reinstateInstitution",
    service: reinstateInstitution,
    suspended: true,
    conflictCode: "institution_not_suspended",
    conflictMessage: "Institution is not currently suspended",
  },
])("$name compare-and-set", (action) => {
  it("re-reads a lost update inside the transaction without auditing", async () => {
    const initial = { id: "i1", suspendedAt: action.suspended ? new Date() : null };
    const current = { id: "i1", suspendedAt: action.suspended ? null : new Date() };
    const { db, inserted, tx } = makeDb(initial, [{ total: 1 }], undefined, [], current);
    await expect(action.service("ops1", "i1", "reason", db)).rejects.toMatchObject({
      code: action.conflictCode,
      status: 409,
      message: action.conflictMessage,
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(tx.select).toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("returns institution_not_found when a lost update re-read finds no row", async () => {
    const initial = { id: "i1", suspendedAt: action.suspended ? new Date() : null };
    const { db, inserted } = makeDb(initial, [{ total: 1 }], undefined, [], null);
    await expect(action.service("ops1", "i1", "reason", db)).rejects.toMatchObject({
      code: "institution_not_found",
      status: 404,
      message: "Institution not found",
    });
    expect(inserted).toHaveLength(0);
  });
});
