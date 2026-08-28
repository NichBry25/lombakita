/**
 * PARTICIPATION-T1 — live two-connection proof for `acquireCompetitionParticipationLock`, the most
 * heavily used lock in the codebase (nine call sites) and, until this script, the only one with no
 * race test of any kind filed against it.
 *
 * The interesting races here are CROSS-FUNCTION, not two copies of one call: the lock exists to
 * serialize every mutation that can change a competition's participant-entry count against the
 * organizer's terminal proceed/cancel decision.
 *
 * Arm 1 — individual registration vs cancel-for-insufficient-participation. The invariant with
 * teeth: NO registration may survive as `confirmed` on a competition cancelled for insufficient
 * participation. Without the lock the registration inserts a row the organizer's bulk cancel has
 * already swept past, and a participant is left holding a confirmed place in a cancelled event.
 *
 * THE CLOCK IS PINNED, and it has to be. `competitions_participant_confirmation_order_chk` requires
 * `registration_end_at <= participant_confirmation_at`, so registration has already closed by the
 * time the decision becomes available — the two overlap only in the instant AT the boundary, where
 * a request that arrived while registration was open is still in flight as the decision begins.
 * That window is real and is precisely what the lock exists for, but it is milliseconds wide. Both
 * services take an injectable `now`, so the racers are pinned either side of the boundary: the
 * registrant at `T - 1ms` (registration open) and the organizer at `T` (decision due). This
 * reproduces the production interleaving deterministically; it does not invent one.
 *
 * Arm 2 — the same race on the team path, where one submission writes one row per member.
 *
 * Arm 3 — the two terminal decisions against each other: cancel-for-insufficient vs
 * confirm-will-proceed. A competition must never end up both cancelled AND confirmed; the loser
 * must get `competition_participation_decision_unavailable` (409).
 *
 * NOT COVERED, deliberately: participant self-cancellation vs the organizer's decision. Those two
 * are legal in disjoint time ranges — `assertParticipantCancellationWindowOpen` closes participant
 * withdrawals at `participantConfirmationAt`, which is exactly when the decision becomes available —
 * so the boundary, not the lock, is what separates them. Driving it would need a pinned fake clock
 * on one side, which would prove something the production path never does.
 *
 * Usage: node --import tsx scripts/concurrency/competition-participation.ts
 * Exit code: 0 when every assertion holds; 1 on a surviving registration, a double decision, or a
 * wrong error.
 */

import {
  assertReadCommitted,
  createChecker,
  describeOutcome,
  finish,
  oneRow,
  openPool,
  race,
  resolveIterations,
} from "./harness";
import { randomUUID } from "crypto";

const ITERATIONS = resolveIterations(5);
const DAY_MS = 24 * 60 * 60 * 1000;
const TEAM_SIZE = 3;

const main = async (): Promise<void> => {
  const { client, db } = await openPool();
  const { createIndividualRegistration } =
    await import("@/server/registrations/registration-service");
  const { submitTeamRegistration } = await import("@/server/teams/team-registration-service");
  const { cancelCompetitionForInsufficientParticipation, confirmCompetitionWillProceed } =
    await import("@/server/competitions/competition-participation-service");

  const { check, failureCount } = createChecker();
  const createdUserIds: string[] = [];
  const createdInstitutionIds: string[] = [];

  const seedUser = async (prefix: string): Promise<string> => {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await client`
      INSERT INTO users (id, email, username, candidate_verified_at, email_verified)
      VALUES (${id}, ${`part_${tag}@example.test`}, ${`part_${prefix}_${tag}`}, now(), now())
    `;
    createdUserIds.push(id);
    return id;
  };

  type SeededCompetition = {
    competitionId: string;
    organizerId: string;
    registrationIds: string[];
    // The confirmation boundary. A registration is legal strictly before it; the organizer's
    // decision is legal from it onwards.
    boundary: Date;
  };

  const seedDecidableCompetition = async (options: {
    mode: "individual" | "team";
    existingRegistrations: number;
  }): Promise<SeededCompetition> => {
    const organizerId = await seedUser("org");
    const tag = organizerId.slice(0, 8);

    const institution = oneRow(
      await client<{ id: string }[]>`
      INSERT INTO institutions (display_name, slug, institution_type)
      VALUES (${`Part Conc ${tag}`}, ${`partconc-${tag}`}, 'company')
      RETURNING id
    `,
      "institution",
    );
    createdInstitutionIds.push(institution.id);

    await client`
      INSERT INTO institution_memberships (institution_id, user_id, membership_role, status)
      VALUES (${institution.id}, ${organizerId}, 'institution_owner', 'active')
    `;

    // registration_end_at and participant_confirmation_at are the SAME instant — the tightest
    // arrangement the order CHECK allows, and the one that puts a still-open registration and an
    // available decision on either side of a single boundary.
    const boundaryMs = Date.now() + DAY_MS;
    // Timestamps go in as ISO strings: postgres.js cannot infer a parameter type for a Date in an
    // INSERT with `prepare: false`, and fails serializing it.
    const at = (offsetMs: number): string => new Date(boundaryMs + offsetMs).toISOString();
    const competition = oneRow(
      await client<{ id: string }[]>`
      INSERT INTO competitions (
        institution_id, created_by_user_id, slug, title, status, mode,
        min_team_size, max_team_size,
        registration_end_at, event_start_at, event_end_at,
        minimum_participant_entries, participant_confirmation_at, published_at
      )
      VALUES (
        ${institution.id}, ${organizerId}, ${`partconc-comp-${tag}`}, ${`Part Conc ${tag}`},
        'published', ${options.mode},
        ${options.mode === "team" ? TEAM_SIZE : null}, ${options.mode === "team" ? TEAM_SIZE : null},
        ${at(0)}, ${at(7 * DAY_MS)}, ${at(8 * DAY_MS)},
        ${99}, ${at(0)}, ${at(-30 * DAY_MS)}
      )
      RETURNING id
    `,
      "competition",
    );

    const registrationIds: string[] = [];
    for (let index = 0; index < options.existingRegistrations; index += 1) {
      const candidateId = await seedUser("cand");
      const registration = oneRow(
        await client<{ id: string }[]>`
        INSERT INTO competition_registrations (competition_id, student_id, registration_type, status)
        VALUES (${competition.id}, ${candidateId}, 'individual', 'confirmed')
        RETURNING id
      `,
        "registration",
      );
      registrationIds.push(registration.id);
    }

    return {
      competitionId: competition.id,
      organizerId,
      registrationIds,
      boundary: new Date(boundaryMs),
    };
  };

  const justBefore = (boundary: Date): Date => new Date(boundary.getTime() - 1);

  const seedFormingTeam = async (competitionId: string): Promise<string> => {
    const captainId = await seedUser("capt");
    const team = oneRow(
      await client<{ id: string }[]>`
      INSERT INTO teams (competition_id, name, captain_id, status)
      VALUES (${competitionId}, ${`Tim ${captainId.slice(0, 6)}`}, ${captainId}, 'forming')
      RETURNING id
    `,
      "team",
    );
    await client`
      INSERT INTO team_memberships (team_id, user_id, role, status)
      VALUES (${team.id}, ${captainId}, 'captain', 'active')
    `;
    for (let index = 1; index < TEAM_SIZE; index += 1) {
      const memberId = await seedUser("mem");
      await client`
        INSERT INTO team_memberships (team_id, user_id, role, status)
        VALUES (${team.id}, ${memberId}, 'member', 'active')
      `;
    }
    return team.id;
  };

  type CompetitionState = {
    cancelled: boolean;
    confirmed: boolean;
    liveRegistrations: number;
    cancelledRegistrations: number;
  };

  const readCompetitionState = async (competitionId: string): Promise<CompetitionState> => {
    const competition = oneRow(
      await client<{ cancelled_at: Date | null; participation_confirmed_at: Date | null }[]>`
      SELECT cancelled_at, participation_confirmed_at FROM competitions WHERE id = ${competitionId}
    `,
      "competition",
    );
    const counts = oneRow(
      await client<{ live: number; cancelled: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS live,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
      FROM competition_registrations WHERE competition_id = ${competitionId}
    `,
      "counts",
    );
    return {
      cancelled: competition.cancelled_at !== null,
      confirmed: competition.participation_confirmed_at !== null,
      liveRegistrations: counts.live,
      cancelledRegistrations: counts.cancelled,
    };
  };

  // A cancelled competition carrying a live registration is the defect this lock exists to prevent:
  // the organizer's bulk cancel swept the rows it could see, and a registration that committed
  // afterwards left a participant holding a confirmed place in an event that is not happening.
  const noLiveRegistrationOnCancelledCompetition = (state: CompetitionState): boolean =>
    !state.cancelled || state.liveRegistrations === 0;

  /**
   * Both orderings of a registration against the organizer's cancellation are legitimate, and each
   * has its OWN expected end state — checking only "no live registrations" would also pass if the
   * registration silently vanished.
   *
   *   registration first: it commits, the cancel then counts it and sweeps it with the rest
   *                       (ok === 2, swept = existing + the new rows)
   *   cancel first:       the registration re-checks under the lock, sees the cancelled
   *                       competition and is refused (swept = existing only)
   */
  const registrationRaceHeld = (
    outcome: { ok: number; failCodes: string[]; other: string[] },
    state: CompetitionState,
    expectedRefusalCode: string,
    existingRows: number,
    newRows: number,
  ): boolean => {
    if (outcome.other.length > 0) return false;
    if (!state.cancelled) return false;
    if (!noLiveRegistrationOnCancelledCompetition(state)) return false;

    if (outcome.ok === 2) {
      return state.cancelledRegistrations === existingRows + newRows;
    }
    return (
      outcome.ok === 1 &&
      outcome.failCodes.length === 1 &&
      outcome.failCodes[0] === expectedRefusalCode &&
      state.cancelledRegistrations === existingRows
    );
  };

  const runIndividualRegistrationVersusCancel = async (): Promise<void> => {
    console.log(
      `\n[individual] ${ITERATIONS} iterations, a registration landing as the organizer cancels`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seeded = await seedDecidableCompetition({
        mode: "individual",
        existingRegistrations: 2,
      });
      const newcomerId = await seedUser("newc");

      const outcome = await race(
        () =>
          createIndividualRegistration(
            newcomerId,
            seeded.competitionId,
            db,
            justBefore(seeded.boundary),
          ),
        () =>
          cancelCompetitionForInsufficientParticipation(
            seeded.organizerId,
            seeded.competitionId,
            db,
            seeded.boundary,
          ),
      );

      const state = await readCompetitionState(seeded.competitionId);
      check(
        registrationRaceHeld(outcome, state, "competition_not_published", 2, 1),
        `iter ${i}: ${describeOutcome(outcome)} cancelled=${state.cancelled} live=${state.liveRegistrations} swept=${state.cancelledRegistrations}` +
          ` [want: cancelled, zero live; registrant first -> swept=3, cancel first -> loser competition_not_published and swept=2]`,
      );
    }
  };

  const runTeamRegistrationVersusCancel = async (): Promise<void> => {
    console.log(
      `\n[team] ${ITERATIONS} iterations, a team submission landing as the organizer cancels`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seeded = await seedDecidableCompetition({ mode: "team", existingRegistrations: 0 });
      const teamId = await seedFormingTeam(seeded.competitionId);
      const captain = oneRow(
        await client<{ user_id: string }[]>`
        SELECT user_id FROM team_memberships WHERE team_id = ${teamId} AND role = 'captain'
      `,
        "captain",
      );

      const outcome = await race(
        () =>
          submitTeamRegistration(
            captain.user_id,
            seeded.competitionId,
            teamId,
            db,
            justBefore(seeded.boundary),
          ),
        () =>
          cancelCompetitionForInsufficientParticipation(
            seeded.organizerId,
            seeded.competitionId,
            db,
            seeded.boundary,
          ),
      );

      const state = await readCompetitionState(seeded.competitionId);
      check(
        registrationRaceHeld(outcome, state, "team_competition_not_published", 0, TEAM_SIZE),
        `iter ${i}: ${describeOutcome(outcome)} cancelled=${state.cancelled} live=${state.liveRegistrations} swept=${state.cancelledRegistrations}` +
          ` [want: cancelled, zero live; team first -> swept=${TEAM_SIZE}, cancel first -> loser team_competition_not_published and swept=0]`,
      );
    }
  };

  const runDecisionVersusDecision = async (): Promise<void> => {
    console.log(
      `\n[decision] ${ITERATIONS} iterations, cancel-for-insufficient vs confirm-will-proceed`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seeded = await seedDecidableCompetition({
        mode: "individual",
        existingRegistrations: 2,
      });

      const outcome = await race(
        () =>
          cancelCompetitionForInsufficientParticipation(
            seeded.organizerId,
            seeded.competitionId,
            db,
            seeded.boundary,
          ),
        () =>
          confirmCompetitionWillProceed(
            seeded.organizerId,
            seeded.competitionId,
            db,
            seeded.boundary,
          ),
      );

      const state = await readCompetitionState(seeded.competitionId);
      const exactlyOneDecision = state.cancelled !== state.confirmed;
      // Each winner produces its own refusal for the loser: a cancelled competition is reported as
      // already cancelled, while a confirmed one no longer has a decision left to make.
      const expectedLoserCode = state.cancelled
        ? "competition_already_cancelled"
        : "competition_participation_decision_unavailable";

      check(
        outcome.ok === 1 &&
          outcome.failCodes.length === 1 &&
          outcome.failCodes[0] === expectedLoserCode &&
          outcome.failStatuses[0] === 409 &&
          outcome.other.length === 0 &&
          exactlyOneDecision &&
          noLiveRegistrationOnCancelledCompetition(state),
        `iter ${i}: ${describeOutcome(outcome)} cancelled=${state.cancelled} confirmed=${state.confirmed} live=${state.liveRegistrations}` +
          ` [want: ok=1 loser=${expectedLoserCode}(409) exactly one decision recorded]`,
      );
    }
  };

  // A lock keyed on a constant rather than the competition would serialize unrelated competitions
  // and still satisfy every assertion above.
  const runCrossCompetitionControl = async (): Promise<void> => {
    console.log(
      `\n[cross-competition] two DIFFERENT competitions decide simultaneously — both must succeed`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const first = await seedDecidableCompetition({
        mode: "individual",
        existingRegistrations: 1,
      });
      const second = await seedDecidableCompetition({
        mode: "individual",
        existingRegistrations: 1,
      });

      const outcome = await race(
        () =>
          cancelCompetitionForInsufficientParticipation(
            first.organizerId,
            first.competitionId,
            db,
            first.boundary,
          ),
        () =>
          confirmCompetitionWillProceed(
            second.organizerId,
            second.competitionId,
            db,
            second.boundary,
          ),
      );

      const firstState = await readCompetitionState(first.competitionId);
      const secondState = await readCompetitionState(second.competitionId);
      check(
        outcome.ok === 2 &&
          outcome.failCodes.length === 0 &&
          firstState.cancelled &&
          secondState.confirmed,
        `iter ${i}: both succeed (${describeOutcome(outcome)}), a=cancelled:${firstState.cancelled} b=confirmed:${secondState.confirmed}`,
      );
    }
  };

  const cleanup = async (): Promise<void> => {
    if (createdInstitutionIds.length > 0) {
      await client`DELETE FROM institutions WHERE id = ANY(${client.array(createdInstitutionIds)})`;
    }
    if (createdUserIds.length > 0) {
      await client`DELETE FROM users WHERE id = ANY(${client.array(createdUserIds)})`;
    }
    console.log(
      `\nCleaned up ${createdUserIds.length} seeded users and ${createdInstitutionIds.length} institutions.`,
    );
  };

  try {
    await assertReadCommitted(client);
    await runIndividualRegistrationVersusCancel();
    await runTeamRegistrationVersusCancel();
    await runDecisionVersusDecision();
    await runCrossCompetitionControl();
  } finally {
    await cleanup();
    await client.end();
  }

  finish(failureCount(), "PARTICIPATION-T1");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
