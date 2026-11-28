import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/competitions/competition-publish-readiness");

import { AccessError } from "@/server/auth/access-core";
import { getDb, type Database } from "@/server/db/client";
import {
  assertCompetitionAccess,
  assertCompetitionHasAudience,
  assertCompetitionHasOrganizerContact,
  assertInstitutionNameChecked,
  assertInstitutionNotSuspended,
  assertInstitutionVerified,
  type CompetitionAccessResult,
} from "@/server/competitions/competition-access";
import { CompetitionError, validatePublishChecklist } from "@/server/competitions/competition-core";
import { loadCompetitionPricing } from "@/server/competitions/competition-service";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";
import {
  readHostCheckStateForActor,
  type HostCheckReadout,
} from "@/server/host-trust/host-check-service";

// WHAT THIS ANSWERS, AND WHY IT IS NOT THE PUBLISH PATH.
//
// The publish button used to be described by the form's own state: dirty fields, missing fields,
// a broken timeline. Every one of those is a fact about the FORM. The gates that actually refuse a
// publish are facts about the ACCOUNT and the INSTITUTION — a `minimal`-tier recruiter, a suspended
// institution, a paid competition under an unverified organizer — and a control that says "ready"
// while the server refuses is a control that lies.
//
// So this asks the publish path's own questions, IN ITS ORDER, and reports all of the answers. It
// does not re-implement any of them: every gate here is the function `transitionCompetitionStatus`
// calls at the same point (competition-service.ts:867-916). A copy of an eligibility rule is a
// second answer that drifts; the surfaces are told what the server will do because they asked the
// server's own guards. Only a draft has anything to ask: a published competition has no publish
// control, so it gets no answer.
//
// THE ONE STRUCTURAL DIFFERENCE: the publish path stops at the first refusal, because it is
// aborting a write. This collects them all, because a disabled control has to explain itself once
// rather than reveal a second reason after the first is fixed.
export const COMPETITION_PUBLISH_BLOCKER_CODES = [
  // The order is the publish path's execution order. Read it as a description of what a caller
  // sees first, not as a priority this module invents.
  "forbidden",
  // The publish endpoint's refusal of a published competition. This read never reports it.
  "competition_invalid_transition",
  "institution_suspended",
  "competition_publish_validation_failed",
  "competition_organizer_contact_missing",
  "competition_audience_missing",
  "competition_institution_not_verified",
  "competition_institution_name_check_pending",
] as const;

export type CompetitionPublishBlockerCode = (typeof COMPETITION_PUBLISH_BLOCKER_CODES)[number];

export const isCompetitionPublishBlockerCode = (
  value: unknown,
): value is CompetitionPublishBlockerCode =>
  typeof value === "string" &&
  (COMPETITION_PUBLISH_BLOCKER_CODES as readonly string[]).includes(value);

export type CompetitionPublishReadiness = {
  canPublish: boolean;
  blockers: CompetitionPublishBlockerCode[];
  // Present for a draft the caller may publish. Absent when the answer is forbidden or the
  // competition is not a draft.
  hostCheck?: HostCheckReadout;
};

// Runs one gate and records its refusal code. A gate that throws something outside the blocker set
// is not a refusal the caller can act on — `competition_not_found` from a read, a bug — so it
// propagates. Swallowing it here would turn a real fault into "cannot publish yet".
const collectGate = async (
  gate: () => Promise<unknown>,
  blockers: CompetitionPublishBlockerCode[],
): Promise<void> => {
  try {
    await gate();
  } catch (error) {
    if (!(error instanceof CompetitionError) || !isCompetitionPublishBlockerCode(error.code)) {
      throw error;
    }
    blockers.push(error.code);
  }
};

/**
 * Whether `actorUserId` can publish `competitionId` right now, and every reason if not.
 *
 * `forbidden` is the first gate and is the only one that can end the evaluation early: the gates
 * after it need the competition row that `assertCompetitionAccess` is what hands over. A caller who
 * is neither an owner nor staff learns that and nothing else, which is the same thing the publish
 * path tells them, in the same order.
 *
 * A competition that does not exist is NOT a readiness answer and is not reported as one. It
 * propagates as the 404 it is, because "you cannot publish this" is the wrong thing to say about a
 * row that is not there.
 */
export const resolveCompetitionPublishReadiness = async (
  actorUserId: string,
  competitionId: string,
  db: Database = getDb(),
): Promise<CompetitionPublishReadiness> => {
  let access: CompetitionAccessResult;
  try {
    access = await assertCompetitionAccess(actorUserId, competitionId, "member", db);
  } catch (error) {
    if (error instanceof AccessError && error.code === "forbidden") {
      return { canPublish: false, blockers: ["forbidden"] };
    }
    throw error;
  }

  const { competition } = access;

  // A published competition has no publish control, so there is no refusal to explain. The publish
  // endpoint still refuses it with `competition_invalid_transition`; only this read stays silent.
  if (competition.status !== "draft") {
    return { canPublish: false, blockers: [] };
  }

  const blockers: CompetitionPublishBlockerCode[] = [];

  await collectGate(() => assertInstitutionNotSuspended(competition.institutionId, db), blockers);

  // The checklist returns rather than throws, so it is read rather than caught. Its input is the
  // merged DB row, not a caller payload — the same source the publish path validates, for the same
  // reason: a partial PATCH that left the row inconsistent has to be caught by whoever publishes.
  const checklist = validatePublishChecklist({
    title: competition.title,
    description: competition.description,
    category: competition.category,
    mode: competition.mode,
    location: competition.location,
    minTeamSize: competition.minTeamSize,
    maxTeamSize: competition.maxTeamSize,
    registrationStartAt: competition.registrationStartAt,
    registrationEndAt: competition.registrationEndAt,
    eventStartAt: competition.eventStartAt,
    eventEndAt: competition.eventEndAt,
    resultAnnouncementAt: competition.resultAnnouncementAt,
    minimumParticipantEntries: competition.minimumParticipantEntries,
    participantConfirmationAt: competition.participantConfirmationAt,
  });
  if (!checklist.passed) {
    blockers.push("competition_publish_validation_failed");
  }

  await collectGate(() => assertCompetitionHasOrganizerContact(competitionId, db), blockers);
  await collectGate(() => assertCompetitionHasAudience(competitionId, db), blockers);

  // The charging gate is conditional in the publish path and conditional here, for the same reason
  // (DEC-0158): verification gates the right to CHARGE, so a free competition is not blocked by an
  // unverified institution and must not be described as if it were.
  const pricing = await loadCompetitionPricing(competitionId, db);
  if (isPaidCompetition(pricing.feeAmount)) {
    await collectGate(() => assertInstitutionVerified(competition.institutionId, db), blockers);
    await collectGate(() => assertInstitutionNameChecked(competition.institutionId, db), blockers);
  }

  const hostCheck = await readHostCheckStateForActor(actorUserId, competition, db);
  return { canPublish: blockers.length === 0, blockers, hostCheck };
};
