import { and, eq, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { assertAccountNotDeactivated } from "@/server/accounts/deactivated-account";
import { enqueueHostTrustRemoved } from "@/server/async/enqueue";
import { getDb, type Database } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { recordRemovedHostIdentity } from "@/server/host-trust/removed-host-identity";
import {
  OperatorActorError,
  recordOperatorAuditEntry,
  resolvePlatformOpsActor,
  type OperatorActorTransaction,
} from "@/server/platform-ops/operator-actor";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/host-trust/host-trust-removal-service");

// Staff remove a host's trust. Kept out of host-trust-service.ts, which the host step, the code
// confirm and the press import, so they do not load the job queue and the operator audit through it.

export type HostTrustRemovalErrorCode =
  | "host_trust_reason_required"
  | "host_trust_account_not_found"
  | "host_trust_not_trusted"
  | "account_deactivated";

export class HostTrustRemovalError extends Error {
  constructor(
    public readonly code: HostTrustRemovalErrorCode,
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type HostTrustRemovalResult = { accountId: string; tier: "minimal" };

const HOST_TRUST_REASON_MAX_LENGTH = 1000;
export const HOST_TRUST_REMOVED_EVENT = "host_trust.removed";

const trimmedRemovalReasonOrRefuse = (reason: string): string => {
  const trimmedReason = reason.trim();
  if (trimmedReason.length === 0 || trimmedReason.length > HOST_TRUST_REASON_MAX_LENGTH) {
    throw new HostTrustRemovalError(
      "host_trust_reason_required",
      400,
      "A trust removal carries a reason of 1 to 1000 characters",
    );
  }
  return trimmedReason;
};

// The opt-in holds this transaction's id and lasts for this transaction only, so the tier trigger
// lets exactly this transaction move a tier from elevated to minimal, and no later one.
const optIntoTrustRemoval = async (tx: OperatorActorTransaction): Promise<void> => {
  await tx.execute(sql`select set_config('lombakita.trust_removal', txid_current()::text, true)`);
};

// The one UPDATE of a removal: this account only, and only while it is trusted.
const lowerTrustedHostToMinimal = (tx: OperatorActorTransaction, accountId: string) =>
  tx
    .update(users)
    .set({
      recruiterVerificationTier: "minimal",
      hostTrustRemovedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(users.id, accountId), eq(users.recruiterVerificationTier, "elevated")))
    .returning({ id: users.id });

// No row moved: the account does not exist, or it is not trusted.
const refuseUntrustedAccount = async (
  tx: OperatorActorTransaction,
  accountId: string,
): Promise<never> => {
  const [account] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  if (!account) {
    throw new HostTrustRemovalError("host_trust_account_not_found", 404, "Account not found");
  }
  throw new HostTrustRemovalError(
    "host_trust_not_trusted",
    409,
    "The account is not a trusted host",
  );
};

// Sent after the commit and never awaited into a failure: a failed enqueue never undoes a removal.
const enqueueTrustRemovedNotice = async (userId: string, reason: string): Promise<void> => {
  try {
    await enqueueHostTrustRemoved({ userId, reason, epoch: Date.now() });
  } catch (error) {
    logger.warn("host_trust.removed_notice_enqueue_failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Staff remove a host's trust with a reason. One transaction: the platform_ops actor is read first,
// the actor may not name its own account, a de-identified account is refused, the reason is checked,
// then the opt-in, the one UPDATE of this account and the record of the removal, and the audit row
// lands with them. The host's published competitions stay published. After the commit the notice
// goes through the two-channel job.
export const removeHostTrust = async (
  staffUserId: string,
  accountId: string,
  reason: string,
  db: Database = getDb(),
): Promise<HostTrustRemovalResult> => {
  const recordedReason = await db.transaction(async (tx) => {
    const actor = await resolvePlatformOpsActor(tx, staffUserId);
    if (actor.userId === accountId) {
      throw new OperatorActorError(
        "operator_actor_is_target",
        403,
        "A platform-ops account cannot remove its own host trust",
      );
    }
    await assertAccountNotDeactivated(tx, accountId, HostTrustRemovalError);
    const checkedReason = trimmedRemovalReasonOrRefuse(reason);

    await optIntoTrustRemoval(tx);
    const lowered = await lowerTrustedHostToMinimal(tx, accountId);
    if (lowered.length === 0) await refuseUntrustedAccount(tx, accountId);

    // After the UPDATE, whose removal time the record copies, and in this transaction, so a removal
    // never commits without its record.
    await recordRemovedHostIdentity(tx, accountId);

    await recordOperatorAuditEntry(tx, actor, {
      targetUserId: accountId,
      eventType: HOST_TRUST_REMOVED_EVENT,
      reason: checkedReason,
      metadata: { from: "elevated", to: "minimal" },
    });
    return checkedReason;
  });

  await enqueueTrustRemovedNotice(accountId, recordedReason);
  return { accountId, tier: "minimal" };
};
