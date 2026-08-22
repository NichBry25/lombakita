import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/registrations/registration-service");

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitionRegistrations, competitions } from "@/server/db/schema";
import {
  MAX_CANCELLATION_REASON_LENGTH,
  RegistrationError,
  type RegistrationRecord,
} from "@/server/registrations/registration-core";
import { logger } from "@/lib/logger";
import { enqueueRegistrationConfirmed, enqueueRegistrationCancelled } from "@/server/async/enqueue";
import { isParticipantCancellationClosedByConfirmation } from "@/lib/competitions/competition-participation";
import { acquireCompetitionParticipationLock } from "@/server/competitions/competition-participation-lock";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import { hasSubmittedPaymentProof } from "@/server/finance/paid-registration";
import {
  createRegistrationPayment,
  loadRegistrationPricing,
} from "@/server/registrations/registration-payment";
import { RegistrationPaymentError } from "@/server/registrations/registration-payment-core";

const REGISTRATION_COLUMNS = {
  id: competitionRegistrations.id,
  competitionId: competitionRegistrations.competitionId,
  studentId: competitionRegistrations.studentId,
  registrationType: competitionRegistrations.registrationType,
  status: competitionRegistrations.status,
  registeredAt: competitionRegistrations.registeredAt,
  cancelledAt: competitionRegistrations.cancelledAt,
  cancellationReason: competitionRegistrations.cancellationReason,
  createdAt: competitionRegistrations.createdAt,
  updatedAt: competitionRegistrations.updatedAt,
} as const;

// Pure read for downstream steps (4.5 dashboard, 4.6 submission intake).
// Returns the candidate's most recent registration row for this competition (any status), or
// null when no row exists. Callers must scope `studentId` to the authenticated session — this
// helper performs no authorization of its own.
export const getStudentRegistration = async (
  studentId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<RegistrationRecord | null> => {
  const [row] = await db
    .select(REGISTRATION_COLUMNS)
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.studentId, studentId),
        eq(competitionRegistrations.competitionId, competitionId),
      ),
    )
    .orderBy(desc(competitionRegistrations.registeredAt))
    .limit(1);

  return row ?? null;
};

type CompetitionGuardSnapshot = {
  id: string;
  status: "draft" | "published" | "archived";
  mode: "individual" | "team" | "both" | null;
  registrationEndAt: Date | null;
  eventStartAt: Date | null;
  participantConfirmationAt: Date | null;
  cancelledAt: Date | null;
  allowCancellation: boolean;
  cancellationCutoffDays: number | null;
  feeAmount: number | null;
};

type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const loadCompetitionForRegistration = async (
  competitionId: string,
  db: DbOrTx,
): Promise<CompetitionGuardSnapshot | null> => {
  const [row] = await db
    .select({
      id: competitions.id,
      status: competitions.status,
      mode: competitions.mode,
      registrationEndAt: competitions.registrationEndAt,
      eventStartAt: competitions.eventStartAt,
      participantConfirmationAt: competitions.participantConfirmationAt,
      cancelledAt: competitions.cancelledAt,
      allowCancellation: competitions.allowCancellation,
      cancellationCutoffDays: competitions.cancellationCutoffDays,
      feeAmount: competitions.feeAmount,
    })
    .from(competitions)
    .where(and(eq(competitions.id, competitionId), isNull(competitions.deletedAt)))
    .limit(1);

  return row ?? null;
};

const findAnyExistingRegistration = async (
  studentId: string,
  competitionId: string,
  db: DbOrTx,
): Promise<{ id: string; status: string } | null> => {
  const [row] = await db
    .select({ id: competitionRegistrations.id, status: competitionRegistrations.status })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.studentId, studentId),
        eq(competitionRegistrations.competitionId, competitionId),
      ),
    )
    .limit(1);

  return row ?? null;
};

const assertCompetitionAcceptsIndividualRegistration = (
  competition: CompetitionGuardSnapshot,
  now: Date,
): void => {
  if (competition.status !== "published" || competition.cancelledAt) {
    throw new RegistrationError(
      "competition_not_published",
      "Competition is not open for registration",
    );
  }
  if (competition.mode !== "individual" && competition.mode !== "both") {
    throw new RegistrationError(
      "competition_wrong_mode",
      "This competition does not accept individual registrations",
    );
  }
  if (!competition.registrationEndAt || competition.registrationEndAt.getTime() <= now.getTime()) {
    throw new RegistrationError("registration_deadline_passed", "Registration deadline has passed");
  }
};

const assertParticipantCancellationWindowOpen = (
  competition: CompetitionGuardSnapshot,
  now: Date,
): void => {
  if (isParticipantCancellationClosedByConfirmation(competition.participantConfirmationAt, now)) {
    throw new RegistrationError(
      "cancellation_window_closed",
      "The cancellation window closed when participation was confirmed",
    );
  }

  const cutoffDays = competition.cancellationCutoffDays;
  if (!competition.eventStartAt || cutoffDays === null) {
    throw new RegistrationError("cancellation_window_closed", "The cancellation window is closed");
  }
  const windowEnd = competition.eventStartAt.getTime() - cutoffDays * DAY_MS;
  if (now.getTime() > windowEnd) {
    throw new RegistrationError("cancellation_window_closed", "The cancellation window has closed");
  }
};

// Create an individual registration for the calling candidate.
// Enforcement order matches the contract:
//   (a) competition exists (and is not soft-deleted)
//   (b) competition.status === 'published'
//   (c) competition.mode === 'individual' or 'both'
//   (d) registration_deadline (registrationEndAt) not yet passed
//   (e) eligibility helper returns eligible
//   (f) no existing registration row (confirmed OR cancelled — re-registration is blocked)
// The route layer already enforces (auth + role=candidate). This helper does not re-check role
// because it requires `studentId` as input — callers must pass session.user.id.
export const createIndividualRegistration = async (
  studentId: string,
  competitionId: string,
  db: Database = getDb(),
  now?: Date,
): Promise<RegistrationRecord> => {
  const requestAt = now ?? new Date();

  // (a) competition exists
  const competition = await loadCompetitionForRegistration(competitionId, db);

  if (!competition) {
    throw new RegistrationError("competition_not_found", "Competition not found");
  }

  // (b-d) publication, mode, and deadline.
  // DEBT (4.4-D2 carry-forward): this individual-registration path enforces only the END
  // bound of the registration window. The team-submission path enforces BOTH start
  // and end (registration_not_yet_open vs registration_window_closed as distinct codes). A
  // candidate registering individually before `registrationStartAt` currently succeeds. This
  // is documented as a cleanup target — either add `registration_not_yet_open` here
  // for parity, or downgrade the team-side enforcement. Decision deferred until the contract
  // pass.
  assertCompetitionAcceptsIndividualRegistration(competition, requestAt);

  // (e) duplicate guard — block if any prior registration row exists. Re-registration after
  // cancellation is intentionally deferred (product simplification). The DB-level
  // partial unique index protects against concurrent race; this application-layer check
  // additionally blocks the cancelled-then-re-register path.
  const existing = await findAnyExistingRegistration(studentId, competitionId, db);

  if (existing) {
    throw new RegistrationError(
      "registration_already_exists",
      existing.status === "cancelled"
        ? "Registration was cancelled and cannot be reinstated"
        : "Student is already registered for this competition",
      { existingStatus: existing.status },
    );
  }

  // THE REGISTRATION IS `confirmed` WHETHER OR NOT IT HAS BEEN PAID, and that is a deliberate
  // choice rather than the `pending_payment` state going unused by oversight.
  //
  // Payment state is DERIVED by folding the payment's event stream; there is no status column
  // anywhere in the finance domain, precisely so that no second copy of a money fact can disagree
  // with the ledger. Projecting it onto `registrations.status` would create exactly that copy, in
  // the table with the most readers. The paid predicates are the only correct answer to "has this
  // been paid", and they read the events.
  //
  // It also keeps the right to cancel intact: a candidate who has registered and transferred
  // nothing may still withdraw, and `cancelRegistration` admits only `confirmed` rows.
  try {
    const inserted = await db.transaction(async (tx) => {
      await acquireCompetitionParticipationLock(tx, competitionId);
      const mutationAt = now ?? new Date();
      const lockedCompetition = await loadCompetitionForRegistration(competitionId, tx);

      if (!lockedCompetition) {
        throw new RegistrationError("competition_not_found", "Competition not found");
      }
      assertCompetitionAcceptsIndividualRegistration(lockedCompetition, mutationAt);

      const [row] = await tx
        .insert(competitionRegistrations)
        .values({
          competitionId,
          studentId,
          registrationType: "individual",
          status: "confirmed",
          registeredAt: mutationAt,
        })
        .returning(REGISTRATION_COLUMNS);

      if (!row) return row;

      // IN THE SAME TRANSACTION as the registration it prices, so a paid registration without its
      // payment cannot exist. A refusal here (unverified institution, no published account, no fee
      // rule) rolls the registration back with it.
      const pricing = await loadRegistrationPricing(competitionId, tx);

      if (pricing) {
        await createRegistrationPayment(pricing, row.id, studentId, mutationAt, tx);
      }

      return row;
    });

    if (!inserted) {
      throw new RegistrationError(
        "registration_already_exists",
        "Registration could not be created",
      );
    }

    enqueueRegistrationConfirmed({
      registrationId: inserted.id,
      studentId,
      competitionId,
      registrationType: "individual",
    }).catch((err: unknown) => {
      logger.warn("registration.confirmed.enqueue_failed", {
        registrationId: inserted.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return inserted;
  } catch (error) {
    if (error instanceof RegistrationError || error instanceof RegistrationPaymentError) {
      throw error;
    }
    // Postgres unique-violation on the partial unique index when a concurrent request lands
    // between the existence-check and the INSERT. Translate to the same error code as the
    // application-layer guard above.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new RegistrationError(
        "registration_already_exists",
        "Student is already registered for this competition",
      );
    }
    throw error;
  }
};

const loadRegistrationById = async (
  registrationId: string,
  db: Database,
): Promise<RegistrationRecord | null> => {
  const [row] = await db
    .select(REGISTRATION_COLUMNS)
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.id, registrationId))
    .limit(1);

  return row ?? null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Cancel an individual registration owned by the calling candidate.
// Enforcement order (fail-closed, ownership before any policy or reason error):
//   (a) registration exists and matches the URL competitionId
//   (b) registration belongs to this candidate (ownership)
//   (c) registration.status === 'confirmed' (cancelled terminal; pending_payment is Phase 7)
//   (d) cancellationReason required (non-empty, <= 500 chars)
//   (e) if the competition is priced, no bukti transfer has been submitted for this payment group
//   (f) institution allows cancellation (allow_cancellation = true)
//   (g) within the cancellation window: now <= event_start_at - cutoff days
export const cancelRegistration = async (
  studentId: string,
  competitionId: string,
  registrationId: string,
  cancellationReason: string | null,
  db: Database = getDb(),
  now?: Date,
): Promise<RegistrationRecord> => {
  const requestAt = now ?? new Date();
  const registration = await loadRegistrationById(registrationId, db);

  if (!registration || registration.competitionId !== competitionId) {
    throw new RegistrationError("registration_not_found", "Registration not found");
  }

  if (registration.studentId !== studentId) {
    throw new RegistrationError(
      "registration_not_owner",
      "Registration does not belong to the current user",
    );
  }

  if (registration.status !== "confirmed") {
    throw new RegistrationError(
      "registration_wrong_status",
      "Only confirmed registrations can be cancelled",
      { currentStatus: registration.status },
    );
  }

  // (d) reason is required and bounded. Enforced here (after ownership + status) so a non-owner
  // never sees a reason-validation error.
  if (cancellationReason === null || cancellationReason.length === 0) {
    throw new RegistrationError(
      "cancellation_reason_required",
      "A cancellation reason is required",
    );
  }
  if (cancellationReason.length > MAX_CANCELLATION_REASON_LENGTH) {
    throw new RegistrationError(
      "cancellation_reason_too_long",
      `Cancellation reason must be at most ${MAX_CANCELLATION_REASON_LENGTH} characters`,
    );
  }

  const competition = await loadCompetitionForRegistration(competitionId, db);

  if (!competition) {
    // Defensive: the FK guarantees this row exists, but a CASCADE delete in flight could
    // remove it. Treat as not-found from the caller's perspective.
    throw new RegistrationError("competition_not_found", "Competition not found");
  }

  // (e) a paid registration may self-cancel until its payer has claimed to have sent money.
  //
  // This was a blanket refusal on every priced competition. It is now conditional, because the
  // blanket version stripped the right to leave from a candidate who had registered, paid nothing,
  // and simply changed their mind, while the platform holds no money of theirs and has nothing to
  // refund. The line falls at the moment a bukti transfer is submitted: before it, cancelling
  // costs nobody anything; after it, the candidate has asserted a transfer the platform cannot
  // independently verify or reverse.
  //
  // Deliberately the proof-submitted predicate and not either of the other two. Confirmed-paid
  // would leave a candidate whose proof is still awaiting review able to cancel out from under an
  // organiser mid-review, and payment-in-flight would hand the right to cancel BACK the moment a
  // proof was rejected, even though the transfer it evidences may well have happened.
  if (isPaidCompetition(competition.feeAmount)) {
    if (await hasSubmittedPaymentProof(registration.id, db)) {
      throw new RegistrationError(
        "cancellation_not_supported_for_paid",
        "Pendaftaran tidak dapat dibatalkan setelah bukti transfer dikirim",
      );
    }
  }

  // (f) institution must allow cancellation at all.
  if (!competition.allowCancellation) {
    throw new RegistrationError(
      "cancellation_disabled_by_institution",
      "Cancellation is not enabled for this competition",
    );
  }

  // A minimum-participation commitment needs a stable count at its confirmation moment. Once that
  // moment arrives, participant withdrawals close even when the older policy cutoff would allow
  // them; otherwise a confirmed competition could fall below its minimum and reopen cancellation.
  // (g) confirmation and event cutoffs.
  assertParticipantCancellationWindowOpen(competition, requestAt);

  const updated = await db.transaction(async (tx) => {
    await acquireCompetitionParticipationLock(tx, competitionId);
    const mutationAt = now ?? new Date();
    const lockedCompetition = await loadCompetitionForRegistration(competitionId, tx);
    if (!lockedCompetition) {
      throw new RegistrationError("competition_not_found", "Competition not found");
    }
    assertParticipantCancellationWindowOpen(lockedCompetition, mutationAt);

    const [row] = await tx
      .update(competitionRegistrations)
      .set({
        status: "cancelled",
        cancelledAt: mutationAt,
        cancellationReason,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(competitionRegistrations.id, registrationId),
          eq(competitionRegistrations.status, "confirmed"),
        ),
      )
      .returning(REGISTRATION_COLUMNS);

    return row;
  });

  if (!updated) {
    throw new RegistrationError("registration_not_found", "Registration not found");
  }

  enqueueRegistrationCancelled({
    registrationId: updated.id,
    studentId,
    competitionId,
    registrationType: "individual",
  }).catch((err: unknown) => {
    logger.warn("registration.cancelled.enqueue_failed", {
      registrationId: updated.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return updated;
};
