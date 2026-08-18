// @vitest-environment node
//
// Service-layer validation, which runs BEFORE the database and therefore has to be tested without
// one. The database CHECKs that back each of these rules are exercised for real in
// finance-schema-db.integration.test.ts; these assert that a bad call is refused in the
// application rather than surfacing as a raw SQLSTATE.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

const { resolveFeeRule, toFeeRuleTerms } = vi.hoisted(() => ({
  resolveFeeRule: vi.fn(),
  toFeeRuleTerms: vi.fn(),
}));
vi.mock("@/server/finance/fee-rule-service", () => ({ resolveFeeRule, toFeeRuleTerms }));

// The charging gate (DEC-0158) that createPayment calls on any priced payment. Mocked here because
// this file tests createPayment's OWN validation order against a db with no query surface; that the
// gate is real, is reached, and actually refuses is proven against a live Postgres in
// finance-charging-gate-db.integration.test.ts — including a test that fails if the call is removed.
const { assertInstitutionVerified } = vi.hoisted(() => ({
  assertInstitutionVerified: vi.fn().mockResolvedValue({ verificationStatus: "verified" }),
}));
vi.mock("@/server/competitions/competition-access", () => ({ assertInstitutionVerified }));

import {
  appendPaymentEvent,
  createPayment,
  PaymentError,
  type AppendPaymentEventInput,
  type CreatePaymentInput,
  type PaymentEventActor,
} from "@/server/finance/payment-service";
import type { Database } from "@/server/db/client";

const NOW = new Date("2026-08-10T00:00:00Z");

// A db that records what it was asked to insert and returns it. Enough to prove the service's
// own decisions; it proves nothing about the database's, which is what the integration suite is
// for.
const makeInsertDb = () => {
  const values = vi.fn();
  const db = {
    insert: vi.fn().mockReturnValue({
      values: (row: Record<string, unknown>) => {
        values(row);
        const returning = vi.fn().mockResolvedValue([{ id: "row_1", ...row }]);
        return { returning, onConflictDoNothing: vi.fn().mockReturnValue({ returning }) };
      },
    }),
  };
  return { db: db as unknown as Database, values };
};

const paymentInput = (overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
  payerUserId: "user_1",
  receivingInstitutionId: "inst_1",
  subject: { type: "competition_registration", competitionRegistrationId: "reg_1" },
  grossAmount: 150_000,
  currency: "IDR",
  pricedAt: NOW,
  origin: "gateway",
  ...overrides,
});

const eventInput = (overrides: Partial<AppendPaymentEventInput> = {}): AppendPaymentEventInput => ({
  paymentId: "pay_1",
  eventType: "succeeded",
  occurredAt: NOW,
  amount: 150_000,
  currency: "IDR",
  idempotencyKey: "gw:xendit:succeeded:evt_1",
  ...overrides,
});

const GATEWAY: PaymentEventActor = { type: "gateway" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPayment", () => {
  it("snapshots the resolved fee onto the payment row", async () => {
    resolveFeeRule.mockResolvedValue({ id: "rule_1", currency: "IDR" });
    toFeeRuleTerms.mockReturnValue({
      basisPoints: 250,
      flatAmount: 5_000,
      minimumFeeAmount: null,
      maximumFeeAmount: null,
      currency: "IDR",
    });
    const { db, values } = makeInsertDb();

    await createPayment(paymentInput(), db);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        receivingInstitutionId: "inst_1",
        feeRuleId: "rule_1",
        feeBasisPoints: 250,
        feeFlatAmount: 5_000,
        grossAmount: 150_000,
        platformFeeAmount: 8_750,
        institutionNetAmount: 141_250,
      }),
    );
  });

  it("prices against the instant it is given, not the wall clock", async () => {
    resolveFeeRule.mockResolvedValue({ id: "rule_1", currency: "IDR" });
    toFeeRuleTerms.mockReturnValue({
      basisPoints: 0,
      flatAmount: 0,
      minimumFeeAmount: null,
      maximumFeeAmount: null,
      currency: "IDR",
    });
    const { db } = makeInsertDb();
    const pricedAt = new Date("2026-01-01T00:00:00Z");

    await createPayment(paymentInput({ pricedAt }), db);

    expect(resolveFeeRule).toHaveBeenCalledWith("inst_1", pricedAt, db);
  });

  it("refuses to record a payment when no fee rule is in force", async () => {
    resolveFeeRule.mockResolvedValue(null);
    const { db, values } = makeInsertDb();

    await expect(createPayment(paymentInput(), db)).rejects.toMatchObject({
      code: "payment_fee_rule_not_found",
    });
    expect(values).not.toHaveBeenCalled();
  });

  it("refuses a rule denominated in a different currency from the payment", async () => {
    resolveFeeRule.mockResolvedValue({ id: "rule_1", currency: "IDR" });
    toFeeRuleTerms.mockReturnValue({
      basisPoints: 0,
      flatAmount: 0,
      minimumFeeAmount: null,
      maximumFeeAmount: null,
      currency: "USD",
    });
    const { db } = makeInsertDb();

    await expect(createPayment(paymentInput(), db)).rejects.toMatchObject({
      code: "payment_fee_rule_currency_mismatch",
    });
  });

  it("refuses an unsupported currency and a fractional gross before touching the database", async () => {
    const { db, values } = makeInsertDb();

    await expect(createPayment(paymentInput({ currency: "USD" }), db)).rejects.toBeInstanceOf(
      PaymentError,
    );
    await expect(createPayment(paymentInput({ grossAmount: 1_000.5 }), db)).rejects.toMatchObject({
      code: "payment_gross_amount_invalid",
    });
    await expect(createPayment(paymentInput({ grossAmount: -1 }), db)).rejects.toMatchObject({
      code: "payment_gross_amount_invalid",
    });
    expect(values).not.toHaveBeenCalled();
    expect(resolveFeeRule).not.toHaveBeenCalled();
  });
});

describe("appendPaymentEvent", () => {
  it("records the event with a server-derived actor", async () => {
    const { db, values } = makeInsertDb();

    const result = await appendPaymentEvent(
      { type: "user", userId: "ops_1" },
      eventInput({ eventType: "corrected", amount: -500, reason: "double-counted" }),
      db,
    );

    expect(result.deduplicated).toBe(false);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: "user", actorUserId: "ops_1", amount: -500 }),
    );
  });

  // The actor is a positional argument precisely so that it cannot arrive in the input object a
  // route handler builds from a request body. If it ever migrates back onto that object, this
  // stops compiling — which is the point of asserting the shape rather than only the behaviour.
  it("takes the actor outside the input object, where a request body cannot supply it", () => {
    const requestBody = {
      paymentId: "pay_1",
      eventType: "refunded" as const,
      occurredAt: NOW,
      amount: 150_000,
      currency: "IDR",
      reason: "caller supplied",
      idempotencyKey: "gw:xendit:succeeded:evt_2",
      actorType: "user",
      actorUserId: "attacker",
    };

    const input: AppendPaymentEventInput = requestBody;

    expect("actor" in input).toBe(false);
  });

  it("stores no actor user id for a system or gateway event", async () => {
    const { db, values } = makeInsertDb();

    await appendPaymentEvent({ type: "system" }, eventInput(), db);

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null }));
  });

  it("requires a reason on a refund and on a correction", async () => {
    const { db, values } = makeInsertDb();

    await expect(
      appendPaymentEvent(GATEWAY, eventInput({ eventType: "refunded", amount: 150_000 }), db),
    ).rejects.toMatchObject({ code: "payment_event_reason_required" });

    await expect(
      appendPaymentEvent(
        GATEWAY,
        eventInput({ eventType: "corrected", amount: -1, reason: "   " }),
        db,
      ),
    ).rejects.toMatchObject({ code: "payment_event_reason_required" });

    expect(values).not.toHaveBeenCalled();
  });

  it("allows a negative amount only on a correction", async () => {
    const { db } = makeInsertDb();

    await expect(
      appendPaymentEvent(GATEWAY, eventInput({ eventType: "succeeded", amount: -1 }), db),
    ).rejects.toMatchObject({ code: "payment_event_amount_invalid" });

    await expect(
      appendPaymentEvent(
        GATEWAY,
        eventInput({ eventType: "corrected", amount: -1, reason: "overstated" }),
        db,
      ),
    ).resolves.toMatchObject({ deduplicated: false });
  });

  it("requires an amount and a currency together, or neither", async () => {
    const { db } = makeInsertDb();

    await expect(
      appendPaymentEvent(GATEWAY, eventInput({ amount: 150_000, currency: null }), db),
    ).rejects.toMatchObject({ code: "payment_event_currency_mismatch" });

    await expect(
      appendPaymentEvent(GATEWAY, eventInput({ amount: null, currency: "IDR" }), db),
    ).rejects.toMatchObject({ code: "payment_event_currency_mismatch" });

    await expect(
      appendPaymentEvent(
        GATEWAY,
        eventInput({ eventType: "initiated", amount: null, currency: null }),
        db,
      ),
    ).resolves.toMatchObject({ deduplicated: false });
  });

  it("requires an idempotency key", async () => {
    const { db, values } = makeInsertDb();

    await expect(
      appendPaymentEvent(GATEWAY, eventInput({ idempotencyKey: "  " }), db),
    ).rejects.toMatchObject({ code: "payment_event_idempotency_key_required" });
    expect(values).not.toHaveBeenCalled();
  });

  // ON CONFLICT DO NOTHING returns no row when the key is already recorded. The stored row is only
  // a replay of THIS call if it says the same thing.
  const makeConflictDb = (existing: Record<string, unknown>) =>
    ({
      insert: vi.fn().mockReturnValue({
        values: () => ({
          onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([existing]),
      }),
    }) as unknown as Database;

  it("returns the existing event when the unique index refuses a genuine replay", async () => {
    const existing = {
      id: "evt_1",
      paymentId: "pay_1",
      eventType: "succeeded",
      amount: 150_000,
      idempotencyKey: "gw:xendit:succeeded:evt_1",
    };

    const result = await appendPaymentEvent(GATEWAY, eventInput(), makeConflictDb(existing));

    expect(result).toEqual({ event: existing, deduplicated: true });
  });

  // The key is unique GLOBALLY. Without the consistency check the caller is told `deduplicated:
  // true`, handed a stranger's row, and its own event is silently never recorded.
  it("refuses a key already recorded against a different payment", async () => {
    const otherTenantsEvent = {
      id: "evt_other",
      paymentId: "pay_OTHER",
      eventType: "succeeded",
      amount: 1_000_000,
      reason: "why the other institution's money moved",
      idempotencyKey: "gw:xendit:succeeded:evt_1",
    };

    const promise = appendPaymentEvent(GATEWAY, eventInput(), makeConflictDb(otherTenantsEvent));

    await expect(promise).rejects.toMatchObject({
      code: "payment_event_idempotency_key_conflict",
    });
    // The refusal must not disclose the row it refused to hand over.
    await expect(promise).rejects.not.toMatchObject({
      message: expect.stringContaining("pay_OTHER"),
    });
  });

  it("refuses a key reused for a different event type or amount on the same payment", async () => {
    const capture = {
      id: "evt_1",
      paymentId: "pay_1",
      eventType: "succeeded",
      amount: 1_000_000,
      idempotencyKey: "gw:xendit:succeeded:evt_1",
    };

    // A partial refund arriving under a key already used by the capture it reverses.
    await expect(
      appendPaymentEvent(
        GATEWAY,
        eventInput({ eventType: "refunded", amount: 500_000, reason: "partial" }),
        makeConflictDb(capture),
      ),
    ).rejects.toMatchObject({ code: "payment_event_idempotency_key_conflict" });

    await expect(
      appendPaymentEvent(
        GATEWAY,
        eventInput({ amount: 999 }),
        makeConflictDb(capture),
      ),
    ).rejects.toMatchObject({ code: "payment_event_idempotency_key_conflict" });
  });

  const makeRejectingDb = (error: unknown) =>
    ({
      insert: vi.fn().mockReturnValue({
        values: () => ({
          onConflictDoNothing: vi
            .fn()
            .mockReturnValue({ returning: vi.fn().mockRejectedValue(error) }),
        }),
      }),
    }) as unknown as Database;

  // The driver error arrives wrapped by Drizzle; the SQLSTATE is on the cause, not on the throw.
  const wrapped = (constraint: string) =>
    Object.assign(new Error("Failed query: insert into finance_payment_events"), {
      cause: Object.assign(new Error("fk violation"), { code: "23503", constraint_name: constraint }),
    });

  it("reports a missing payment rather than leaking the foreign-key violation", async () => {
    await expect(
      appendPaymentEvent(
        GATEWAY,
        eventInput(),
        makeRejectingDb(wrapped("finance_payment_events_payment_id_fk")),
      ),
    ).rejects.toMatchObject({ code: "payment_not_found" });
  });

  // The table has two foreign keys. An unknown ACTOR reported as a missing PAYMENT would mask the
  // more interesting fault.
  it("distinguishes an unknown acting user from a missing payment", async () => {
    await expect(
      appendPaymentEvent(
        { type: "user", userId: "ghost" },
        eventInput({ eventType: "corrected", amount: -1, reason: "typo" }),
        makeRejectingDb(wrapped("finance_payment_events_actor_user_id_fk")),
      ),
    ).rejects.toMatchObject({ code: "payment_event_actor_unknown" });
  });

  // DrizzleQueryError's message is `Failed query: <sql>\nparams: <bound values>` — the field an
  // error reporter uses as the issue title. In this lane those values are a payer, an institution
  // and an amount, so an unclassified failure must be restated rather than re-thrown.
  it("restates an unclassified database failure without the statement or its values", async () => {
    const leaky = Object.assign(
      new Error('Failed query: insert into finance_payment_events\nparams: user_1,inst_1,150000'),
      { cause: Object.assign(new Error("deadlock"), { code: "40P01" }) },
    );

    let thrown: unknown;
    try {
      await appendPaymentEvent(GATEWAY, eventInput(), makeRejectingDb(leaky));
      expect.unreachable("the database failure should have propagated");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ name: "PaymentDatabaseError", sqlState: "40P01" });

    const { message, cause } = thrown as Error & { cause?: unknown };
    expect(message).not.toContain("150000");
    expect(message).not.toContain("user_1");
    expect(message).not.toContain("params:");
    // The original must not be chained either — a reporter walks the cause chain.
    expect(cause).toBeUndefined();
  });
});
