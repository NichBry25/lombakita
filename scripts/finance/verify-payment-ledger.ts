/**
 * The six product promises of the finance ledger, checked against a real Postgres.
 *
 * This is Step 7.1's manual test. It is a script rather than a browser checklist because the step
 * ships no user-facing surface at all — there is no page to open and no button to click, so the
 * only honest way to confirm the product rules is to drive the real services against a real
 * database and read back what was recorded.
 *
 * Each section below is one of the six business rules, stated in the language the rule is written
 * in rather than in the language of the schema. What makes these checks worth running is that they
 * are not restatements of the unit suite: the unit suite mocks the database, so a CHECK constraint,
 * a unique index and a NOT NULL are all invisible to it, and the properties asserted here — that a
 * refund leaves the capture readable, that yesterday's payment is immune to today's rate, that a
 * retry records nothing new — are exactly the ones that live in the database rather than above it.
 *
 * Run:  node --import tsx scripts/finance/verify-payment-ledger.ts
 *
 * Seeds its own rows and removes them afterwards. Teardown deletes finance rows by raw SQL, which
 * the application itself must never do (DEC-0133) and cannot — the append-only scan covers src/**,
 * and these are seeded fixtures, not a ledger anybody relies on. Because every finance foreign key
 * is NO ACTION, teardown has to run children-before-parents or the database will refuse it, which
 * is itself a small confirmation that the ledger will not quietly disappear.
 *
 * LOCAL DATABASES ONLY, checked before the pool opens. This script writes payments and commits a
 * fee-rule rate change, so the rows it leaves on a shared database are indistinguishable from real
 * ledger data and `finance_payments` has no application delete path to remove them with.
 */

import { assertLocalDatabase, createChecker, databaseUrl, finish, oneRow, openPool } from "../lib/live-harness";

const NOW = new Date("2026-08-10T00:00:00.000Z");
const LAST_MONTH = new Date("2026-07-01T00:00:00.000Z");

// Drizzle binds a JS Date; the raw postgres.js client in this script does not, so timestamps in the
// hand-written seed SQL below go in as ISO strings.
const iso = (at: Date): string => at.toISOString();

const main = async (): Promise<void> => {
  assertLocalDatabase(databaseUrl, "verify-payment-ledger");

  const { client, db } = await openPool(4);
  const { check, failureCount } = createChecker();

  const { createPayment, appendPaymentEvent, loadPaymentLedger } = await import(
    "@/server/finance/payment-service"
  );

  const tag = `ledger_${Date.now()}`;
  const created: { users: string[]; institutions: string[]; feeRules: string[] } = {
    users: [],
    institutions: [],
    feeRules: [],
  };

  try {
    // ---- fixtures -----------------------------------------------------------------------------
    const user = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO users (email, username, candidate_verified_at)
        VALUES (${`${tag}@example.test`}, ${tag}, ${iso(NOW)})
        RETURNING id`,
      "user",
    );
    created.users.push(user.id);

    const organizer = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO institutions (slug, institution_type)
        VALUES (${`${tag}-org`}, 'personal') RETURNING id`,
      "institution",
    );
    const bystander = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO institutions (slug, institution_type)
        VALUES (${`${tag}-other`}, 'personal') RETURNING id`,
      "institution",
    );
    created.institutions.push(organizer.id, bystander.id);

    const competition = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO competitions (institution_id, slug, title)
        VALUES (${organizer.id}, ${`${tag}-comp`}, ${`Ledger fixture ${tag}`})
        RETURNING id`,
      "competition",
    );

    const registration = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO competition_registrations (competition_id, student_id, registration_type)
        VALUES (${competition.id}, ${user.id}, 'individual') RETURNING id`,
      "registration",
    );

    // 2,5% + Rp 0. The rate the payment below is priced under, and the rate changed afterwards.
    const rule = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO finance_fee_rules
          (institution_id, currency, basis_points, flat_amount, effective_from)
        VALUES (NULL, 'IDR', 250, 0, ${iso(LAST_MONTH)}) RETURNING id`,
      "fee rule",
    );
    created.feeRules.push(rule.id);

    const subject = {
      type: "competition_registration" as const,
      competitionRegistrationId: registration.id,
    };

    // ---- 1. Every payment names who receives the money ------------------------------------------
    console.log("\n1. Every payment names who receives the money");

    const payment = await createPayment(
      {
        payerUserId: user.id,
        receivingInstitutionId: organizer.id,
        subject,
        grossAmount: 150_000,
        currency: "IDR",
        origin: "gateway",
      pricedAt: NOW,
      },
      db,
    );

    check(payment.receivingInstitutionId === organizer.id, "the recipient is recorded on the row");

    const nullRecipient = await client`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'finance_payments' AND column_name = 'receiving_institution_id'`;
    check(
      (nullRecipient[0] as { is_nullable: string } | undefined)?.is_nullable === "NO",
      "a payment that cannot name its recipient is refused by the database, not by convention",
    );

    // ---- 2. The platform is a facilitator, not a holder -----------------------------------------
    console.log("\n2. The platform is a facilitator, not a holder");

    check(
      payment.platformFeeAmount + payment.institutionNetAmount === payment.grossAmount,
      `the split accounts for every rupiah (${payment.platformFeeAmount} + ${payment.institutionNetAmount} = ${payment.grossAmount})`,
    );
    check(
      payment.institutionNetAmount === 146_250 && payment.platformFeeAmount === 3_750,
      "the institution's share is the money, the platform's share is the fee",
    );

    // The rule this project must be able to prove at any time: nothing anywhere models a balance.
    const custodyColumns = await client<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name LIKE 'finance%'
        AND (column_name LIKE '%balance%' OR column_name LIKE '%payout%'
             OR column_name LIKE '%owed%' OR column_name LIKE '%held%'
             OR column_name LIKE '%escrow%' OR column_name LIKE '%unclaimed%')`;
    check(
      custodyColumns.length === 0,
      "no column in the finance schema means 'what the platform currently holds'",
    );

    // ---- 3. Yesterday's money is not rewritten by today's pricing -------------------------------
    console.log("\n3. Yesterday's money is not rewritten by today's pricing");

    await client`UPDATE finance_fee_rules SET basis_points = 1000 WHERE id = ${rule.id}`;

    const afterRateChange = oneRow(
      await client<{ platform_fee_amount: string; fee_basis_points: number }[]>`
        SELECT platform_fee_amount, fee_basis_points FROM finance_payments WHERE id = ${payment.id}`,
      "payment",
    );
    check(
      Number(afterRateChange.platform_fee_amount) === 3_750 &&
        afterRateChange.fee_basis_points === 250,
      "quadrupling the rate today leaves the payment recorded yesterday untouched",
    );

    // ---- 4. A retried operation charges once ----------------------------------------------------
    console.log("\n4. A retried operation charges once");

    const captureKey = `gateway__${tag}__capture`;
    const capture = await appendPaymentEvent(
      { type: "gateway" },
      {
        paymentId: payment.id,
        eventType: "succeeded",
        occurredAt: NOW,
        amount: 150_000,
        currency: "IDR",
        idempotencyKey: captureKey,
      },
      db,
    );

    const retry = await appendPaymentEvent(
      { type: "gateway" },
      {
        paymentId: payment.id,
        eventType: "succeeded",
        occurredAt: NOW,
        amount: 150_000,
        currency: "IDR",
        idempotencyKey: captureKey,
      },
      db,
    );

    check(retry.deduplicated && retry.event.id === capture.event.id, "the retry records nothing new");

    const captureCount = oneRow(
      await client<{ n: string }[]>`
        SELECT count(*) AS n FROM finance_payment_events
        WHERE payment_id = ${payment.id} AND event_type = 'succeeded'`,
      "count",
    );
    check(Number(captureCount.n) === 1, "the payment was captured exactly once");

    // A key is not a replay just because it repeats. Reusing one for different money must refuse,
    // or the second charge is silently lost and the ledger understates what happened.
    let reuseRefused = "";
    try {
      await appendPaymentEvent(
        { type: "gateway" },
        {
          paymentId: payment.id,
          eventType: "refunded",
          occurredAt: NOW,
          amount: 50_000,
          currency: "IDR",
          reason: "different operation, same key",
          idempotencyKey: captureKey,
        },
        db,
      );
    } catch (error) {
      reuseRefused = (error as { code?: string }).code ?? "";
    }
    check(
      reuseRefused === "payment_event_idempotency_key_conflict",
      "reusing that key for a different operation is refused, not silently swallowed",
    );

    // ---- 5. A refund never erases history -------------------------------------------------------
    console.log("\n5. A refund never erases history");

    await appendPaymentEvent(
      { type: "user", userId: user.id },
      {
        paymentId: payment.id,
        eventType: "refunded",
        occurredAt: new Date("2026-08-12T00:00:00.000Z"),
        amount: 150_000,
        currency: "IDR",
        reason: "organizer cancelled the competition",
        idempotencyKey: `user__${tag}__refund`,
      },
      db,
    );

    const refunded = await loadPaymentLedger(organizer.id, payment.id, db);

    check(refunded?.state.status === "refunded", "the payment reads as refunded");
    check(
      refunded?.events.some((event) => event.eventType === "succeeded" && event.amount === 150_000) ===
        true,
      "the original capture is still there to read, with its amount intact",
    );
    check(refunded?.state.capturedAmount === 150_000, "the ledger still reports what was captured");
    check(
      refunded?.events.find((event) => event.eventType === "refunded")?.reason ===
        "organizer cancelled the competition",
      "the refund records why the money moved back",
    );

    // ---- 6. A correction is visible as a correction ---------------------------------------------
    console.log("\n6. A correction is visible as a correction");

    await appendPaymentEvent(
      { type: "user", userId: user.id },
      {
        paymentId: payment.id,
        eventType: "corrected",
        occurredAt: new Date("2026-08-13T00:00:00.000Z"),
        amount: -10_000,
        currency: "IDR",
        reason: "the gateway reported the fee twice",
        idempotencyKey: `user__${tag}__correction`,
      },
      db,
    );

    const corrected = await loadPaymentLedger(organizer.id, payment.id, db);
    const correction = corrected?.events.find((event) => event.eventType === "corrected");

    check(correction !== undefined, "the correction is its own row, not an edit of an earlier one");
    check(correction?.reason === "the gateway reported the fee twice", "it states why");
    check(correction?.actorType === "user", "it names a person, not the system");
    check(
      corrected?.events.length === 3,
      "nothing was removed — capture, refund and correction all stand",
    );
    check(
      corrected?.state.correctionAmount === -10_000,
      "the correction is reported separately from what was captured",
    );

    // ---- boundary: one organizer's money is not another's ---------------------------------------
    console.log("\n7. One organizer cannot read another's money");

    const foreign = await loadPaymentLedger(bystander.id, payment.id, db);
    check(foreign === null, "a different institution asking for this payment gets nothing");
  } finally {
    // Children before parents: every finance foreign key is NO ACTION, so the database refuses any
    // other order — which is the point of NO ACTION.
    await client`DELETE FROM finance_payment_events WHERE payment_id IN
      (SELECT id FROM finance_payments WHERE receiving_institution_id = ANY(${created.institutions}))`;
    await client`DELETE FROM finance_payments WHERE receiving_institution_id = ANY(${created.institutions})`;
    await client`DELETE FROM finance_fee_rules WHERE id = ANY(${created.feeRules})`;
    await client`DELETE FROM competition_registrations WHERE student_id = ANY(${created.users})`;
    await client`DELETE FROM competitions WHERE institution_id = ANY(${created.institutions})`;
    await client`DELETE FROM institutions WHERE id = ANY(${created.institutions})`;
    await client`DELETE FROM users WHERE id = ANY(${created.users})`;
    await client.end();
  }

  finish(failureCount(), "FINANCE LEDGER");
};

void main();
