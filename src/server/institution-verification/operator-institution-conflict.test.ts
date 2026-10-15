// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
  OPERATOR_ACTOR_CONFLICTED_MESSAGE,
  assertOperatorHasNoInstitutionRelationship,
} from "./operator-institution-conflict";
import {
  OperatorActorError,
  type OperatorActorTransaction,
  type ResolvedPlatformOpsActor,
} from "@/server/platform-ops/operator-actor";

// The helper issues four reads in a fixed order: membership, filed submission, the actor's email,
// invitation. `rowsByRead` is what each of those resolves to, in that order.
const makeTransaction = (rowsByRead: Array<Array<Record<string, unknown>>>) => {
  let read = 0;
  return {
    select: vi.fn(() => {
      const rows = rowsByRead[read++] ?? [];
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
        }),
      };
    }),
  } as unknown as OperatorActorTransaction;
};

const actor = { userId: "ops1" } as unknown as ResolvedPlatformOpsActor;

const arms = [
  { arm: "membership", rowsByRead: [[{ id: "m1" }]] },
  { arm: "filed submission", rowsByRead: [[], [{ id: "s1" }]] },
  { arm: "invitation", rowsByRead: [[], [], [{ email: "Ops@Example.test" }], [{ id: "inv1" }]] },
];

describe("assertOperatorHasNoInstitutionRelationship", () => {
  it.each(arms)("refuses the $arm arm with the default message", async ({ rowsByRead }) => {
    const tx = makeTransaction(rowsByRead);
    const refusal = await assertOperatorHasNoInstitutionRelationship(tx, actor, "i1").catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({
      code: "operator_actor_conflicted",
      status: 403,
      message: OPERATOR_ACTOR_CONFLICTED_MESSAGE,
    });
  });

  it.each(arms)("refuses the $arm arm with a supplied message", async ({ rowsByRead }) => {
    const tx = makeTransaction(rowsByRead);
    const refusal = await assertOperatorHasNoInstitutionRelationship(
      tx,
      actor,
      "i1",
      OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({
      code: "operator_actor_conflicted",
      status: 403,
      message: OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
    });
  });

  it("keeps the two messages distinct", () => {
    expect(OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE).toBe(
      "A platform-ops account cannot act on an institution it has filed for, been invited to, or held any membership in",
    );
    expect(OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE).not.toBe(OPERATOR_ACTOR_CONFLICTED_MESSAGE);
  });

  it("resolves when the actor has no relationship to the institution", async () => {
    const tx = makeTransaction([[], [], [{ email: "ops@example.test" }], []]);
    await expect(
      assertOperatorHasNoInstitutionRelationship(tx, actor, "i1"),
    ).resolves.toBeUndefined();
  });
});
