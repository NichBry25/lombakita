// @vitest-environment node
//
// The finance guards, run against a real Postgres.
//
// Every rule asserted here is enforced by a CHECK, a unique index or a NOT NULL — which means the
// unit suite structurally cannot test them: it mocks the database, so removing a CHECK from
// schema.ts leaves every mocked test green. Only Postgres can settle whether the constraint is
// actually there and actually fires, and each test here is written so that DELETING ITS GUARD makes
// it fail (an insert that should be refused would simply succeed).
//
// Also covered here, for the same reason: fee-rule resolution (its precedence lives in an ORDER BY)
// and fee-snapshot immutability (the proof is that re-reading a stored row after changing a rule
// returns the same figures).
//
// Every test runs inside a transaction that is ALWAYS rolled back, so the dev database is left
// byte-identical. Nothing here is committed.
//
// Skipped when no DATABASE_URL is reachable, so a developer without a local database can still
// run `npm test`. NOT skippable in CI: `REQUIRE_DB_TESTS=1` makes a missing database a hard
// failure instead (see server/testing/database-url.ts) — this suite proving nothing while
// reporting green is the defect this guard exists to prevent.

import { afterAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TransactionRollbackError, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  competitionRegistrations,
  competitions,
  financeFeeRules,
  financePaymentEvents,
  financePayments,
  institutions,
  users,
} from "@/server/db/schema";
import { computePlatformFee } from "@/lib/finance/fee";

const DATABASE_URL = TEST_DATABASE_URL;

const NOW = new Date("2026-08-10T00:00:00.000Z");
const LAST_MONTH = new Date("2026-07-01T00:00:00.000Z");

const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

const inRollback = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("no database");
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

/**
 * Runs `body` in a SAVEPOINT so a deliberately-rejected insert does not abort the outer
 * transaction, and returns the SQLSTATE plus constraint name Postgres answered with.
 *
 * Asserting on the constraint NAME is what makes these tests specific: an insert refused by the
 * wrong constraint would otherwise read as a pass.
 */
const expectRejection = async (
  tx: Tx,
  body: (tx: Tx) => Promise<unknown>,
): Promise<{ code: string; constraint: string }> => {
  try {
    await tx.transaction(async (nested) => {
      await body(nested);
    });
  } catch (error) {
    // Drizzle wraps the driver error; the SQLSTATE lives on the cause, not on what was thrown.
    let current: unknown = error;
    for (let depth = 0; current && depth < 5; depth += 1) {
      const e = current as {
        code?: string;
        constraint_name?: string;
        constraint?: string;
        cause?: unknown;
      };
      if (typeof e.code === "string") {
        return { code: e.code, constraint: e.constraint_name ?? e.constraint ?? "" };
      }
      current = e.cause;
    }
    throw error;
  }
  throw new Error("expected the database to refuse this row, but it was accepted");
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}_${seq++}`;

type Fixture = {
  userId: string;
  institutionId: string;
  otherInstitutionId: string;
  registrationId: string;
  feeRuleId: string;
};

/** Seeds the whole FK chain a payment needs, plus a global default fee rule. */
const seedFixture = async (tx: Tx): Promise<Fixture> => {
  const id = uniqueSuffix();

  const [user] = await tx
    .insert(users)
    .values({
      email: `finance_${id}@example.test`,
      username: `finance_${id}`,
      // users_one_verified_role_chk requires at least one verified role.
      candidateVerifiedAt: NOW,
    })
    .returning({ id: users.id });

  const [institution] = await tx
    .insert(institutions)
    // institutions_display_name_type_chk allows a null display name only for `personal`.
    // VERIFIED, because createPayment's DEC-0158 charging gate refuses a priced payment for an
    // unverified institution. That refusal is the subject of its own suite
    // (finance-charging-gate-db.integration.test.ts); here it would only mask what these tests are
    // actually asserting about constraints and fee snapshots.
    .values({
      slug: `finance-inst-${id}`,
      institutionType: "personal",
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  const [otherInstitution] = await tx
    .insert(institutions)
    .values({ slug: `finance-other-${id}`, institutionType: "personal" })
    .returning({ id: institutions.id });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `finance-comp-${id}`,
      title: `Finance fixture ${id}`,
    })
    .returning({ id: competitions.id });

  const [registration] = await tx
    .insert(competitionRegistrations)
    .values({
      competitionId: competition!.id,
      studentId: user!.id,
      registrationType: "individual",
    })
    .returning({ id: competitionRegistrations.id });

  const [feeRule] = await tx
    .insert(financeFeeRules)
    .values({
      institutionId: null,
      currency: "IDR",
      basisPoints: 250,
      flatAmount: 0,
      effectiveFrom: LAST_MONTH,
    })
    .returning({ id: financeFeeRules.id });

  return {
    userId: user!.id,
    institutionId: institution!.id,
    otherInstitutionId: otherInstitution!.id,
    registrationId: registration!.id,
    feeRuleId: feeRule!.id,
  };
};

const paymentValues = (fixture: Fixture, overrides: Record<string, unknown> = {}) => {
  const fee = computePlatformFee(1_000_000, {
    basisPoints: 250,
    flatAmount: 0,
    minimumFeeAmount: null,
    maximumFeeAmount: null,
    currency: "IDR",
  });

  return {
    payerUserId: fixture.userId,
    receivingInstitutionId: fixture.institutionId,
    // Gateway lane by default: these fixtures assert the fee SPLIT, which the manual lane
    // deliberately does not have (a manual payment records fee 0 / net = gross).
    origin: "gateway" as const,
    subjectType: "competition_registration" as const,
    competitionRegistrationId: fixture.registrationId,
    currency: "IDR",
    grossAmount: fee.grossAmount,
    feeRuleId: fixture.feeRuleId,
    feeBasisPoints: fee.feeBasisPoints,
    feeFlatAmount: fee.feeFlatAmount,
    platformFeeAmount: fee.platformFeeAmount,
    institutionNetAmount: fee.institutionNetAmount,
    ...overrides,
  };
};

/** Counts the events recorded against one payment. */
const countEvents = async (tx: Tx, paymentId: string): Promise<number> => {
  const rows = await tx
    .select({ id: financePaymentEvents.id })
    .from(financePaymentEvents)
    .where(eq(financePaymentEvents.paymentId, paymentId));
  return rows.length;
};

const seedPayment = async (tx: Tx, fixture: Fixture): Promise<string> => {
  const [payment] = await tx
    .insert(financePayments)
    .values(paymentValues(fixture))
    .returning({ id: financePayments.id });
  return payment!.id;
};

describe.skipIf(skipWithoutDatabase)("finance_payments constraints (real database)", () => {
  it("refuses a payment with no subject key at all", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .insert(financePayments)
          .values(paymentValues(fixture, { competitionRegistrationId: null })),
      );

      expect(rejection.code).toBe("23514");
      expect(rejection.constraint).toBe("finance_payments_subject_xor_chk");
    });
  });

  // DEC-0130: a payment that cannot name its recipient would be one the platform is implicitly
  // holding. The column is NOT NULL so the database refuses it outright.
  it("refuses a payment with no receiving institution", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .insert(financePayments)
          .values(paymentValues(fixture, { receivingInstitutionId: null })),
      );

      expect(rejection.code).toBe("23502");
    });
  });

  it("refuses a split that does not add up", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financePayments).values(
          paymentValues(fixture, {
            platformFeeAmount: 25_000,
            institutionNetAmount: 900_000,
            grossAmount: 1_000_000,
          }),
        ),
      );

      expect(rejection.constraint).toBe("finance_payments_split_balance_chk");
    });
  });

  it("refuses a negative net, so an institution can never owe money on its own sale", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financePayments).values(
          paymentValues(fixture, {
            grossAmount: 1_000,
            platformFeeAmount: 26_000,
            institutionNetAmount: -25_000,
          }),
        ),
      );

      expect(rejection.constraint).toBe("finance_payments_fee_snapshot_chk");
    });
  });

  it("refuses a currency that is not an ISO-4217 code", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financePayments).values(paymentValues(fixture, { currency: "rupiah" })),
      );

      expect(rejection.constraint).toBe("finance_payments_currency_chk");
    });
  });

  it("refuses to delete a fee rule that priced a payment", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      await seedPayment(tx, fixture);

      const rejection = await expectRejection(tx, (nested) =>
        nested.delete(financeFeeRules).where(eq(financeFeeRules.id, fixture.feeRuleId)),
      );

      // NO ACTION: nothing in the finance domain disappears because a neighbouring row did.
      expect(rejection.code).toBe("23503");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("finance_payment_events constraints (real database)", () => {
  const eventValues = (paymentId: string, overrides: Record<string, unknown> = {}) => ({
    paymentId,
    eventType: "succeeded" as const,
    occurredAt: NOW,
    amount: 1_000_000,
    currency: "IDR",
    actorType: "gateway" as const,
    idempotencyKey: `gw:xendit:succeeded:key_${uniqueSuffix()}`,
    ...overrides,
  });

  it("rejects a second event carrying an idempotency key already used", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedPayment(tx, fixture);
      const key = `replay_${uniqueSuffix()}`;

      await tx.insert(financePaymentEvents).values(eventValues(paymentId, { idempotencyKey: key }));

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financePaymentEvents).values(
          eventValues(paymentId, {
            idempotencyKey: key,
            eventType: "failed",
            amount: null,
            currency: null,
          }),
        ),
      );

      expect(rejection.code).toBe("23505");
      expect(rejection.constraint).toBe("finance_payment_events_idempotency_key_idx");

      const stored = await countEvents(tx, paymentId);
      expect(stored).toBe(1);
    });
  });

  it("rejects a correction with no reason and a refund with a blank one", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedPayment(tx, fixture);

      const noReason = await expectRejection(tx, (nested) =>
        nested
          .insert(financePaymentEvents)
          .values(eventValues(paymentId, { eventType: "corrected", amount: -1_000 })),
      );
      expect(noReason.constraint).toBe("finance_payment_events_reason_required_chk");

      const blankReason = await expectRejection(tx, (nested) =>
        nested
          .insert(financePaymentEvents)
          .values(eventValues(paymentId, { eventType: "refunded", reason: "   " })),
      );
      expect(blankReason.constraint).toBe("finance_payment_events_reason_required_chk");
    });
  });

  it("allows a negative amount only on a correction", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedPayment(tx, fixture);

      const rejection = await expectRejection(tx, (nested) =>
        nested
          .insert(financePaymentEvents)
          .values(eventValues(paymentId, { eventType: "succeeded", amount: -1_000 })),
      );
      expect(rejection.constraint).toBe("finance_payment_events_amount_sign_chk");

      await tx.insert(financePaymentEvents).values(
        eventValues(paymentId, {
          eventType: "corrected",
          amount: -1_000,
          reason: "gateway reported the fee twice",
        }),
      );
      expect(await countEvents(tx, paymentId)).toBe(1);
    });
  });

  it("requires an amount and a currency together", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedPayment(tx, fixture);

      const rejection = await expectRejection(tx, (nested) =>
        nested.insert(financePaymentEvents).values(eventValues(paymentId, { currency: null })),
      );

      expect(rejection.constraint).toBe("finance_payment_events_amount_currency_chk");
    });
  });

  it("requires a named user for a user event and forbids one otherwise", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedPayment(tx, fixture);

      const missingUser = await expectRejection(tx, (nested) =>
        nested.insert(financePaymentEvents).values(
          eventValues(paymentId, {
            actorType: "user",
            eventType: "corrected",
            amount: -1,
            reason: "typo",
          }),
        ),
      );
      expect(missingUser.constraint).toBe("finance_payment_events_actor_chk");

      const strayUser = await expectRejection(tx, (nested) =>
        nested
          .insert(financePaymentEvents)
          .values(eventValues(paymentId, { actorType: "system", actorUserId: fixture.userId })),
      );
      expect(strayUser.constraint).toBe("finance_payment_events_actor_chk");
    });
  });

  it("refuses to delete a payment that has events", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const paymentId = await seedPayment(tx, fixture);
      await tx.insert(financePaymentEvents).values(eventValues(paymentId));

      const rejection = await expectRejection(tx, (nested) =>
        nested.delete(financePayments).where(eq(financePayments.id, paymentId)),
      );

      expect(rejection.code).toBe("23503");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("fee rules and the payment snapshot (real database)", () => {
  it("prefers an institution-scoped rule over the global default", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { resolveFeeRule } = await import("@/server/finance/fee-rule-service");

      const [scoped] = await tx
        .insert(financeFeeRules)
        .values({
          institutionId: fixture.institutionId,
          currency: "IDR",
          basisPoints: 100,
          effectiveFrom: LAST_MONTH,
        })
        .returning({ id: financeFeeRules.id });

      const resolved = await resolveFeeRule(fixture.institutionId, NOW, tx as never);
      expect(resolved?.id).toBe(scoped!.id);

      // A different institution still gets the global default.
      const other = await resolveFeeRule(fixture.otherInstitutionId, NOW, tx as never);
      expect(other?.id).toBe(fixture.feeRuleId);
    });
  });

  it("ignores a rule that has not started and one that has ended", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { resolveFeeRule } = await import("@/server/finance/fee-rule-service");

      await tx.insert(financeFeeRules).values({
        institutionId: fixture.institutionId,
        currency: "IDR",
        basisPoints: 9_000,
        effectiveFrom: new Date("2027-01-01T00:00:00.000Z"),
      });
      await tx.insert(financeFeeRules).values({
        institutionId: fixture.institutionId,
        currency: "IDR",
        basisPoints: 8_000,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: new Date("2026-02-01T00:00:00.000Z"),
      });

      const resolved = await resolveFeeRule(fixture.institutionId, NOW, tx as never);
      expect(resolved?.id).toBe(fixture.feeRuleId);
    });
  });

  // The single most common defect in this class of schema, and the reason the snapshot is
  // structural rather than derived.
  it("leaves an already-recorded payment untouched when the fee rule changes", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { createPayment } = await import("@/server/finance/payment-service");

      const payment = await createPayment(
        {
          payerUserId: fixture.userId,
          receivingInstitutionId: fixture.institutionId,
          origin: "gateway",
          subject: {
            type: "competition_registration",
            competitionRegistrationId: fixture.registrationId,
          },
          grossAmount: 1_000_000,
          currency: "IDR",
          pricedAt: NOW,
        },
        tx as never,
      );

      expect(payment.feeBasisPoints).toBe(250);
      expect(payment.platformFeeAmount).toBe(25_000);
      expect(payment.institutionNetAmount).toBe(975_000);

      // The platform quadruples its rate on the rule the payment was priced under.
      await tx
        .update(financeFeeRules)
        .set({ basisPoints: 1_000 })
        .where(eq(financeFeeRules.id, fixture.feeRuleId));

      const [reread] = await tx
        .select()
        .from(financePayments)
        .where(eq(financePayments.id, payment.id));

      expect(reread!.feeBasisPoints).toBe(250);
      expect(reread!.platformFeeAmount).toBe(25_000);
      expect(reread!.institutionNetAmount).toBe(975_000);
      expect(reread!.grossAmount).toBe(1_000_000);
    });
  });
});

describe.skipIf(skipWithoutDatabase)("loadPaymentLedger (real database)", () => {
  it("folds the stored events and scopes the read to the owning institution", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { appendPaymentEvent, loadPaymentLedger } =
        await import("@/server/finance/payment-service");
      const paymentId = await seedPayment(tx, fixture);

      await appendPaymentEvent(
        { type: "gateway" },
        {
          paymentId,
          eventType: "succeeded",
          occurredAt: NOW,
          amount: 1_000_000,
          currency: "IDR",
          idempotencyKey: `gw:xendit:succeeded:ok_${uniqueSuffix()}`,
        },
        tx as never,
      );

      const refundKey = `gw:xendit:refunded:refund_${uniqueSuffix()}`;
      const first = await appendPaymentEvent(
        { type: "user", userId: fixture.userId },
        {
          paymentId,
          eventType: "refunded",
          occurredAt: new Date("2026-08-12T00:00:00.000Z"),
          amount: 1_000_000,
          currency: "IDR",
          reason: "organizer cancelled the competition",
          idempotencyKey: refundKey,
        },
        tx as never,
      );

      // The same operation retried under the same key records nothing new.
      const replay = await appendPaymentEvent(
        { type: "user", userId: fixture.userId },
        {
          paymentId,
          eventType: "refunded",
          occurredAt: new Date("2026-08-12T00:00:00.000Z"),
          amount: 1_000_000,
          currency: "IDR",
          reason: "organizer cancelled the competition",
          idempotencyKey: refundKey,
        },
        tx as never,
      );
      expect(replay.deduplicated).toBe(true);
      expect(replay.event.id).toBe(first.event.id);

      const ledger = await loadPaymentLedger(fixture.institutionId, paymentId, tx as never);

      expect(ledger?.events).toHaveLength(2);
      expect(ledger?.state.status).toBe("refunded");
      expect(ledger?.state.capturedAmount).toBe(1_000_000);
      // The refund is a reversing row; the success it reverses is still there to read.
      expect(ledger?.events[0]?.eventType).toBe("succeeded");
      expect(ledger?.events[0]?.amount).toBe(1_000_000);

      // Another institution asking for the same payment gets nothing, not someone else's money.
      const crossTenant = await loadPaymentLedger(
        fixture.otherInstitutionId,
        paymentId,
        tx as never,
      );
      expect(crossTenant).toBeNull();
    });
  });

  // The idempotency index is unique GLOBALLY, so a suppressed insert proves only that the key was
  // used before — not that it was used for THIS payment. Proven here against the real index rather
  // than a mock, because a mocked insert cannot suppress anything and so cannot reach this branch.
  it("refuses a key already recorded against another institution's payment", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { appendPaymentEvent } = await import("@/server/finance/payment-service");

      const minePaymentId = await seedPayment(tx, fixture);
      const [theirs] = await tx
        .insert(financePayments)
        .values(paymentValues(fixture, { receivingInstitutionId: fixture.otherInstitutionId }))
        .returning({ id: financePayments.id });

      const sharedKey = `gw:xendit:succeeded:collision_${uniqueSuffix()}`;

      await appendPaymentEvent(
        { type: "gateway" },
        {
          paymentId: theirs!.id,
          eventType: "succeeded",
          occurredAt: NOW,
          amount: 1_000_000,
          currency: "IDR",
          idempotencyKey: sharedKey,
        },
        tx as never,
      );

      await expect(
        appendPaymentEvent(
          { type: "gateway" },
          {
            paymentId: minePaymentId,
            eventType: "succeeded",
            occurredAt: NOW,
            amount: 1_000_000,
            currency: "IDR",
            idempotencyKey: sharedKey,
          },
          tx as never,
        ),
      ).rejects.toMatchObject({ code: "payment_event_idempotency_key_conflict" });

      // Refused, not silently absorbed: my payment still has no events at all.
      expect(await countEvents(tx, minePaymentId)).toBe(0);
    });
  });

  // The reverse hazard of a silent dedup: a second partial refund suppressed under a reused key
  // leaves refundedAmount understating reality, and the fold then reports a fully-refunded payment
  // as still `succeeded`. The conflict check is what stops the fold ever seeing that stream.
  it("refuses a second partial refund that reuses the first refund's key", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { appendPaymentEvent, loadPaymentLedger } =
        await import("@/server/finance/payment-service");
      const paymentId = await seedPayment(tx, fixture);

      await appendPaymentEvent(
        { type: "gateway" },
        {
          paymentId,
          eventType: "succeeded",
          occurredAt: NOW,
          amount: 1_000_000,
          currency: "IDR",
          idempotencyKey: `gw:xendit:succeeded:cap_${uniqueSuffix()}`,
        },
        tx as never,
      );

      // The key a "refund this payment" call naturally reaches for: derived from the payment. This
      // is that defect in its original form, and it is refused BEFORE it can be
      // written — the convention's enforcement in assertEventInput turns a key that would have
      // collided on the second refund into an input error on the first.
      const derivedKey = `refund__${paymentId}`;

      const partial = (amount: number, idempotencyKey: string) =>
        appendPaymentEvent(
          { type: "user", userId: fixture.userId },
          {
            paymentId,
            eventType: "refunded",
            occurredAt: NOW,
            amount,
            currency: "IDR",
            reason: "partial refund",
            idempotencyKey,
          },
          tx as never,
        );

      await expect(partial(400_000, derivedKey)).rejects.toMatchObject({
        code: "payment_event_idempotency_key_malformed",
      });

      // And the conflict guard still stands behind it for a CONFORMING key reused across two
      // different amounts, which is what a gateway replaying one event id under a changed payload
      // would look like. Belt and braces: the convention stops the shape, this stops the reuse.
      const conformingKey = `gw:xendit:succeeded:reused_${uniqueSuffix()}`;
      await partial(400_000, conformingKey);
      await expect(partial(600_000, conformingKey)).rejects.toMatchObject({
        code: "payment_event_idempotency_key_conflict",
      });

      // The ledger reports what it actually holds, and does not claim the payment is settled.
      const ledger = await loadPaymentLedger(fixture.institutionId, paymentId, tx as never);
      expect(ledger?.state.refundedAmount).toBe(400_000);
      expect(ledger?.state.status).toBe("succeeded");
    });
  });

  // The key that is CHECKED must be the key that is STORED, or the guard checks one string and the
  // index enforces another. Validating a trimmed value while inserting the raw one lets a padded key
  // land with its padding: the gateway's retry then mints the canonical form, the index sees a
  // different string, `ON CONFLICT` does not fire, and one event records twice in a ledger with no
  // delete path. Only a real database can show this — a mocked insert stores nothing to compare.
  it("stores the canonical key it validated, so a padded replay still collapses", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { appendPaymentEvent, loadPaymentLedger } =
        await import("@/server/finance/payment-service");
      const paymentId = await seedPayment(tx, fixture);

      const canonical = `gw:xendit:succeeded:pad_${uniqueSuffix()}`;
      const capture = (idempotencyKey: string) =>
        appendPaymentEvent(
          { type: "gateway" },
          {
            paymentId,
            eventType: "succeeded",
            occurredAt: NOW,
            amount: 1_000_000,
            currency: "IDR",
            idempotencyKey,
          },
          tx as never,
        );

      const padded = await capture(`  ${canonical}\n`);
      expect(padded.deduplicated).toBe(false);
      expect(padded.event.idempotencyKey).toBe(canonical);

      // The retry, arriving with the key the minting helper produces. It must be recognised as the
      // same event rather than recorded as a second capture of the same money.
      const retry = await capture(canonical);
      expect(retry.deduplicated).toBe(true);
      expect(retry.event.id).toBe(padded.event.id);

      const ledger = await loadPaymentLedger(fixture.institutionId, paymentId, tx as never);
      expect(ledger?.events).toHaveLength(1);
    });
  });

  // The property the whole convention exists for, proven against a real database: two genuine
  // partial refunds on ONE payment, keyed by the minting helper, both record. Under the old
  // `<verb>__<paymentId>` shape the second was swallowed or refused, and the ledger understated
  // what had actually been refunded — in an append-only ledger, an event that never landed is the
  // worse harm, because there is no later write that restates it.
  it("records a second partial refund on the same payment when keys are minted (FINANCE-D11)", async () => {
    await inRollback(async (tx) => {
      const fixture = await seedFixture(tx);
      const { appendPaymentEvent, loadPaymentLedger } =
        await import("@/server/finance/payment-service");
      const { mintPlatformPaymentEventKey } = await import("@/server/finance/idempotency-key");
      const paymentId = await seedPayment(tx, fixture);

      await appendPaymentEvent(
        { type: "gateway" },
        {
          paymentId,
          eventType: "succeeded",
          occurredAt: NOW,
          amount: 1_000_000,
          currency: "IDR",
          idempotencyKey: `gw:xendit:succeeded:cap_${uniqueSuffix()}`,
        },
        tx as never,
      );

      const refund = (amount: number) =>
        appendPaymentEvent(
          { type: "user", userId: fixture.userId },
          {
            paymentId,
            eventType: "refunded",
            occurredAt: NOW,
            amount,
            currency: "IDR",
            reason: "partial refund",
            // Minted per call. Two refunds are two intents, and the UUID is what lets the ledger
            // say so.
            idempotencyKey: mintPlatformPaymentEventKey({ action: "refunded", paymentId }),
          },
          tx as never,
        );

      const first = await refund(400_000);
      const second = await refund(600_000);

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(false);
      expect(second.event.id).not.toBe(first.event.id);

      // Both landed, so the fold sees the payment fully refunded rather than half of it.
      const ledger = await loadPaymentLedger(fixture.institutionId, paymentId, tx as never);
      expect(ledger?.state.refundedAmount).toBe(1_000_000);
      expect(ledger?.state.status).toBe("refunded");
    });
  });
});
