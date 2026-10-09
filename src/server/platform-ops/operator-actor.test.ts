// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import * as operatorActor from "./operator-actor";
import type { OperatorActorTransaction, ResolvedPlatformOpsActor } from "./operator-actor";

const makeTransaction = (row: { id: string; role: string; suspendedAt: Date | null } | null) => {
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values }),
  } as unknown as OperatorActorTransaction;
  return { tx, values };
};

type ResolveOperatorActor = (
  tx: OperatorActorTransaction,
  actorUserId: string,
  roles: readonly ("platform_ops" | "finance_ops")[],
) => Promise<ResolvedPlatformOpsActor>;

const resolveOperatorActor: ResolveOperatorActor = (tx, actorUserId, roles) => {
  // Keep the tests-only commit type-correct so CI reaches the missing capability assertion.
  const resolve = Reflect.get(operatorActor, "resolveOperatorActor") as
    | ResolveOperatorActor
    | undefined;
  expect(resolve, "resolveOperatorActor must be exported").toBeTypeOf("function");
  return resolve!(tx, actorUserId, roles);
};

describe("resolveOperatorActor", () => {
  it("accepts finance_ops when finance_ops is required", async () => {
    const { tx } = makeTransaction({
      id: "database-finance",
      role: "finance_ops",
      suspendedAt: null,
    });
    const actor = await resolveOperatorActor(tx, "claimed-finance", ["finance_ops"]);
    expect(actor.userId).toBe("database-finance");
    expect(Object.isFrozen(actor)).toBe(true);
  });

  it("refuses platform_ops when finance_ops is required with the existing code", async () => {
    const { tx } = makeTransaction({ id: "ops", role: "platform_ops", suspendedAt: null });
    await expect(resolveOperatorActor(tx, "ops", ["finance_ops"])).rejects.toMatchObject({
      code: "operator_actor_not_platform_ops",
      status: 403,
      message: expect.stringContaining("finance_ops"),
    });
  });

  it.each(["platform_ops", "finance_ops"])(
    "accepts %s from a readonly list of both roles",
    async (role) => {
      const { tx } = makeTransaction({ id: "actor", role, suspendedAt: null });
      const roles = ["platform_ops", "finance_ops"] as const;
      expect((await resolveOperatorActor(tx, "actor", roles)).userId).toBe("actor");
    },
  );

  it("names all required roles when refusing a candidate", async () => {
    const { tx } = makeTransaction({ id: "candidate", role: "candidate", suspendedAt: null });
    await expect(
      resolveOperatorActor(tx, "candidate", ["platform_ops", "finance_ops"]),
    ).rejects.toMatchObject({
      code: "operator_actor_not_platform_ops",
      status: 403,
      message: expect.stringMatching(/platform_ops.*finance_ops/),
    });
  });

  it("refuses a missing actor with the existing code", async () => {
    const { tx } = makeTransaction(null);
    await expect(resolveOperatorActor(tx, "absent", ["platform_ops"])).rejects.toMatchObject({
      code: "operator_actor_not_found",
      status: 403,
    });
  });

  it("refuses a suspended finance operator with the existing code", async () => {
    const { tx } = makeTransaction({ id: "finance", role: "finance_ops", suspendedAt: new Date() });
    await expect(resolveOperatorActor(tx, "finance", ["finance_ops"])).rejects.toMatchObject({
      code: "operator_actor_suspended",
      status: 403,
    });
  });
});

describe("recordOperatorAuditEntry transaction binding", () => {
  it("refuses an actor resolved in a different transaction object before inserting", async () => {
    const first = makeTransaction({ id: "ops", role: "platform_ops", suspendedAt: null });
    const second = makeTransaction({ id: "ops", role: "platform_ops", suspendedAt: null });
    const actor = await operatorActor.resolvePlatformOpsActor(first.tx, "ops");
    const refusal = await operatorActor
      .recordOperatorAuditEntry(second.tx, actor, { eventType: "test" })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(operatorActor.OperatorActorError);
    expect(second.values).not.toHaveBeenCalled();
  });

  it("writes exactly one audit row with an actor resolved in the same transaction", async () => {
    const { tx, values } = makeTransaction({
      id: "database-ops",
      role: "platform_ops",
      suspendedAt: null,
    });
    const actor = await operatorActor.resolvePlatformOpsActor(tx, "claimed-ops");
    await operatorActor.recordOperatorAuditEntry(tx, actor, { eventType: "test" });
    expect(values).toHaveBeenCalledExactlyOnceWith({
      eventType: "test",
      actorUserId: "database-ops",
    });
  });
});
