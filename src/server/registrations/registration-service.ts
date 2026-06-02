import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/registrations/registration-service");

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { competitionRegistrations, competitions } from "@/server/db/schema";
import { checkStudentEligibility } from "@/server/eligibility/eligibility-service";
import {
  RegistrationError,
  type RegistrationRecord,
} from "@/server/registrations/registration-core";
import { logger } from "@/lib/logger";
import {
  enqueueRegistrationConfirmed,
  enqueueRegistrationCancelled,
} from "@/server/async/enqueue";

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
};

const loadCompetitionForRegistration = async (
  competitionId: string,
  db: Database,
): Promise<CompetitionGuardSnapshot | null> => {
  const [row] = await db
    .select({
      id: competitions.id,
      status: competitions.status,
      mode: competitions.mode,
      registrationEndAt: competitions.registrationEndAt,
    })
    .from(competitions)
    .where(and(eq(competitions.id, competitionId), isNull(competitions.deletedAt)))
    .limit(1);

  return row ?? null;
};

const findAnyExistingRegistration = async (
  studentId: string,
  competitionId: string,
  db: Database,
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
  now: Date = new Date(),
): Promise<RegistrationRecord> => {
  // (a) competition exists
  const competition = await loadCompetitionForRegistration(competitionId, db);

  if (!competition) {
    throw new RegistrationError("competition_not_found", "Competition not found");
  }

  // (b) competition is published
  if (competition.status !== "published") {
    throw new RegistrationError(
      "competition_not_published",
      "Competition is not open for registration",
    );
  }

  // (c) registration mode supports individual entry
  if (competition.mode !== "individual" && competition.mode !== "both") {
    throw new RegistrationError(
      "competition_wrong_mode",
      "This competition does not accept individual registrations",
    );
  }

  // (d) registration deadline not passed (server time only — never trust client).
  // DEBT (4.4-D2 carry-forward): this individual-registration path enforces only the END
  // bound of the registration window. The Step 4.4 team-submission path enforces BOTH start
  // and end (registration_not_yet_open vs registration_window_closed as distinct codes). A
  // candidate registering individually before `registrationStartAt` currently succeeds. This
  // is documented as a Phase 4 cleanup target — either add `registration_not_yet_open` here
  // for parity, or downgrade the team-side enforcement. Decision deferred until the contract
  // pass.
  if (!competition.registrationEndAt || competition.registrationEndAt.getTime() <= now.getTime()) {
    throw new RegistrationError("registration_deadline_passed", "Registration deadline has passed");
  }

  // (e) eligibility re-checked server-side on every create attempt
  const eligibility = await checkStudentEligibility(studentId, db);

  if (eligibility.status !== "eligible") {
    throw new RegistrationError(
      "registration_ineligible",
      "Student does not meet competition eligibility requirements",
      { eligibilityStatus: eligibility.status, reasons: eligibility.reasons },
    );
  }

  // (f) duplicate guard — block if any prior registration row exists. Re-registration after
  // cancellation is intentionally deferred (Step 4.2 product simplification). The DB-level
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

  // Phase 7: pending_payment state — not reachable in MVP. All competitions are free; insert
  // directly to confirmed.
  try {
    const [inserted] = await db
      .insert(competitionRegistrations)
      .values({
        competitionId,
        studentId,
        registrationType: "individual",
        status: "confirmed",
        registeredAt: now,
      })
      .returning(REGISTRATION_COLUMNS);

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
    if (error instanceof RegistrationError) {
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

// Cancel a registration owned by the calling candidate.
// Enforcement order:
//   (a) registration exists for this id
//   (b) registration belongs to this candidate (ownership)
//   (c) registration matches the URL competitionId
//   (d) registration.status === 'confirmed' (cancelled is terminal; pending_payment is Phase 7)
//   (e) competition.registration_deadline not yet passed
// `cancellationReason` is optional and stored as-is when provided.
export const cancelRegistration = async (
  studentId: string,
  competitionId: string,
  registrationId: string,
  cancellationReason: string | null,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<RegistrationRecord> => {
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

  const competition = await loadCompetitionForRegistration(competitionId, db);

  if (!competition) {
    // Defensive: the FK guarantees this row exists, but a CASCADE delete in flight could
    // remove it. Treat as not-found from the caller's perspective.
    throw new RegistrationError("competition_not_found", "Competition not found");
  }

  if (!competition.registrationEndAt || competition.registrationEndAt.getTime() <= now.getTime()) {
    throw new RegistrationError("registration_deadline_passed", "Registration deadline has passed");
  }

  const [updated] = await db
    .update(competitionRegistrations)
    .set({
      status: "cancelled",
      cancelledAt: now,
      cancellationReason,
      updatedAt: sql`now()`,
    })
    .where(eq(competitionRegistrations.id, registrationId))
    .returning(REGISTRATION_COLUMNS);

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
