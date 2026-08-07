import type { Database } from "@/server/db/client";
import { platformOpsAuditLogs } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { MFA_EVENT } from "./mfa-core";

assertServerOnly("server/auth/mfa/mfa-audit");

export type MfaAuditEventType = (typeof MFA_EVENT)[keyof typeof MFA_EVENT];

/**
 * What an MFA audit row says HAPPENED. Deliberately carries no actor and no target: the account is
 * a leading positional parameter of `appendMfaAuditEvent`, so this object is the only part a
 * request payload may legitimately shape.
 */
export type MfaAuditEvent = {
  eventType: MfaAuditEventType;
  reason?: string;
};

/**
 * Writes one `platform_ops_audit_logs` row for an MFA lifecycle event, inside the caller's
 * transaction, so the audit commits with the mutation it records (CLAUDE.md Rule 7 / DEC-0114).
 *
 * `actorUserId` is a LEADING POSITIONAL parameter, not a field on `event` (DEC-0140). This is the
 * whole reason the helper exists: an actor that lives on an object can be supplied by an object
 * spread of a request payload — `appendMfaAuditEvent({ ...body })` would type-check, satisfy every
 * constraint, and write a forged attribution onto an identity event. A positional argument cannot
 * be spread into. Placing it FIRST rather than appending it is also deliberate: a call site that
 * has not been updated fails at compile time instead of binding silently to the wrong slot. It
 * matches `suspendUser(actorUserId, …)` and `setFeaturedPlacement(actorUserId, …)`, and it
 * deliberately takes precedence over the tx-first ordering used elsewhere in this directory.
 *
 * Actor and target are the same account by construction: every MFA event here is self-initiated
 * identity work — an operator enrolling, being locked out, or resetting their OWN factor — never
 * one operator acting on another.
 */
export const appendMfaAuditEvent = async (
  actorUserId: string,
  tx: Database,
  event: MfaAuditEvent,
): Promise<void> => {
  await tx.insert(platformOpsAuditLogs).values({
    actorUserId,
    targetUserId: actorUserId,
    eventType: event.eventType,
    reason: event.reason ?? null,
  });
};
