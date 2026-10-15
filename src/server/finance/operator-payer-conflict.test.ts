// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import { assertOperatorIsNotPayer } from "./operator-payer-conflict";
import {
  OperatorActorError,
  type ResolvedPlatformOpsActor,
} from "@/server/platform-ops/operator-actor";

const actor = { userId: "ops1" } as unknown as ResolvedPlatformOpsActor;

describe("assertOperatorIsNotPayer", () => {
  it("refuses when the actor is the payer", () => {
    let refusal: unknown;
    try {
      assertOperatorIsNotPayer(actor, "ops1");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({
      code: "operator_actor_is_target",
      status: 403,
      message: "A platform-ops account cannot act on a payment it made",
    });
  });

  it("returns when the payer is another account", () => {
    expect(() => assertOperatorIsNotPayer(actor, "someone-else")).not.toThrow();
  });
});
