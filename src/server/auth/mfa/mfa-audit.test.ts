// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import { appendMfaAuditEvent, type MfaAuditEvent } from "./mfa-audit";
import { MFA_EVENT } from "./mfa-core";

const makeInsertTx = () => {
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = { insert: vi.fn().mockReturnValue({ values }) };
  return { tx: tx as unknown as Database, values };
};

describe("appendMfaAuditEvent", () => {
  it("records the account as both actor and target, with the event's own type and reason", async () => {
    const { tx, values } = makeInsertTx();

    await appendMfaAuditEvent("ops_1", tx, {
      eventType: MFA_EVENT.reset,
      reason: "recovery code redemption",
    });

    expect(values).toHaveBeenCalledWith({
      actorUserId: "ops_1",
      targetUserId: "ops_1",
      eventType: "mfa.reset",
      reason: "recovery code redemption",
    });
  });

  it("writes a null reason when the event carries none", async () => {
    const { tx, values } = makeInsertTx();

    await appendMfaAuditEvent("ops_1", tx, { eventType: MFA_EVENT.enrolled });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ reason: null }));
  });

  // DEC-0140. The actor is a LEADING POSITIONAL parameter precisely so that it cannot arrive in the
  // event object — an object is spreadable, so an actor living on one could be supplied by
  // `appendMfaAuditEvent({ ...requestBody })` and write a forged attribution onto an identity event.
  // The `@ts-expect-error` below is the assertion: if `actorUserId` ever migrates onto `MfaAuditEvent`
  // the excess-property error disappears, the directive becomes unused, and typecheck FAILS.
  it("keeps the actor off the event object, where a payload spread could otherwise supply it", async () => {
    const { tx, values } = makeInsertTx();

    const forgedPayload: MfaAuditEvent = {
      eventType: MFA_EVENT.reset,
      reason: "recovery code redemption",
      // @ts-expect-error — actorUserId is a positional parameter, never a field on MfaAuditEvent.
      actorUserId: "attacker",
    };

    await appendMfaAuditEvent("ops_real", tx, forgedPayload);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "ops_real", targetUserId: "ops_real" }),
    );
    expect(values).not.toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "attacker" }));
  });
});
