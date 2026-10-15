import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  OperatorActorError,
  type ResolvedPlatformOpsActor,
} from "@/server/platform-ops/operator-actor";

assertServerOnly("server/finance/operator-payer-conflict");

// NOBODY ACTS ON A PAYMENT THEY MADE. A platform-ops account that is also a payer is a party to the
// proof, so a void or a receipt view it performs would read in the audit trail as independent.
export const assertOperatorIsNotPayer = (
  actor: ResolvedPlatformOpsActor,
  payerUserId: string,
): void => {
  if (actor.userId === payerUserId) {
    throw new OperatorActorError(
      "operator_actor_is_target",
      403,
      "An operator account cannot act on a payment it made",
    );
  }
};
