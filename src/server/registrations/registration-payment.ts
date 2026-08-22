import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/registrations/registration-payment");

import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitions } from "@/server/db/schema";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import { resolvePaymentDueAt } from "@/lib/finance/payment-window";
import { createPayment } from "@/server/finance/payment-service";
import { RegistrationPaymentError } from "@/server/registrations/registration-payment-core";

// WHERE A REGISTRATION ACQUIRES ITS DEBT.
//
// One implementation, called by BOTH the individual and the team registration paths. Two copies of
// "work out what this costs and record it" is how one mode ends up charging and the other silently
// not, and the mode that silently does not charge produces registrations the organiser believes
// are paid for.
//
// CALLED INSIDE THE REGISTRATION'S OWN TRANSACTION, always. A paid registration without its payment
// is unreachable because the two are written together or neither is: the registration insert and
// this call share one transaction, so a refusal here takes the registration down with it. That is
// the intended behaviour and not a rough edge. A candidate holding a registration for a
// competition that could not price them is worse than a candidate who was told to try later.
//
// A TEAM PAYS ONCE. The caller passes the captain's registration id and nothing else; the payment
// anchors there, and the payment-group predicates resolve the other members' rows back to it. This
// function has no notion of team versus individual, deliberately. That distinction lives in which
// registration id the caller hands it.

/** Everything the pricing decision needs, read from the competition being registered for. */
export type RegistrationPricingSnapshot = {
  id: string;
  institutionId: string;
  feeAmount: number | null;
  feeCurrency: string | null;
  paymentWindowDays: number;
  registrationEndAt: Date | null;
};

/**
 * The pricing fields for one competition.
 *
 * Read as its own query rather than taken from a caller's projection: the registration paths' guard
 * snapshot omits most of these, and a money decision made from a projection that excludes the fee
 * columns reads every competition as free.
 */
export const loadRegistrationPricing = async (
  competitionId: string,
  db: Database = getDb(),
): Promise<RegistrationPricingSnapshot | null> => {
  const [row] = await db
    .select({
      id: competitions.id,
      institutionId: competitions.institutionId,
      feeAmount: competitions.feeAmount,
      feeCurrency: competitions.feeCurrency,
      paymentWindowDays: competitions.paymentWindowDays,
      registrationEndAt: competitions.registrationEndAt,
    })
    .from(competitions)
    .where(eq(competitions.id, competitionId))
    .limit(1);

  return row ?? null;
};

/**
 * Records the payment a new registration owes, or does nothing when the competition is free.
 *
 * FREE COMPETITIONS GET NO PAYMENT ROW AT ALL. Not a zero-gross row, none. A free registration has
 * no debt, no deadline and no instructions to snapshot, and recording one would put a row in the
 * ledger that every "has this been paid" question then has to learn to ignore.
 *
 * The deadline is resolved HERE, at the moment of registration, and clamped to registration close.
 * It is snapshotted onto the payment and never recomputed, so an organiser who later shortens the
 * window does not move a deadline this candidate was already given.
 *
 * Every refusal `createPayment` can raise (the institution is unverified, it has published no
 * account, no fee rule is in force) collapses to ONE candidate-facing code. All three mean the
 * same thing to the person registering: this organiser cannot take payment right now, and none of
 * it is the candidate's to fix. Distinguishing them here would leak the organiser's verification
 * state and its billing configuration to anyone who clicks register.
 */
export const createRegistrationPayment = async (
  pricing: RegistrationPricingSnapshot,
  registrationId: string,
  payerUserId: string,
  at: Date,
  db: Database,
): Promise<void> => {
  if (!isPaidCompetition(pricing.feeAmount)) return;

  if (pricing.feeCurrency === null) {
    // A CHECK makes this unreachable: a priced competition must carry a currency. Asserted rather
    // than coerced to a default, because a default here would price somebody in a currency nobody
    // chose.
    throw new RegistrationPaymentError(
      "registration_payment_unavailable",
      "Kompetisi ini belum dapat menerima pembayaran. Hubungi penyelenggara.",
    );
  }

  const dueAt = resolvePaymentDueAt(at, pricing.paymentWindowDays, pricing.registrationEndAt);

  try {
    await createPayment(
      {
        payerUserId,
        receivingInstitutionId: pricing.institutionId,
        origin: "manual_transfer",
        subject: { type: "competition_registration", competitionRegistrationId: registrationId },
        grossAmount: pricing.feeAmount ?? 0,
        currency: pricing.feeCurrency,
        pricedAt: at,
        dueAt,
      },
      db,
    );
  } catch (error) {
    if (error instanceof RegistrationPaymentError) throw error;

    throw new RegistrationPaymentError(
      "registration_payment_unavailable",
      "Kompetisi ini belum dapat menerima pembayaran. Hubungi penyelenggara.",
      error,
    );
  }
};
