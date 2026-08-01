// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ASYNC_JOB_NAMES, ASYNC_QUEUE_NAMES } from "@/server/async/contracts";
import {
  ASYNC_JOB_REGISTRATIONS,
  getQueueRegistrations,
  getRegisteredQueueNames,
  getRegistrationByJobName,
} from "@/server/async/registry";

describe("async queue registration baseline", () => {
  it("registers all expected jobs across infrastructure, competition, results, and notifications queues", () => {
    // Step 6.5.1 added competition.edited + competition.cancelled; Step 6.5e added
    // institution.invitation.dispatch + team.invitation.dispatch; the recruiter-verification
    // rejection notice added recruiter.verification.rejected; participant document verification
    // added registration.document.requested + registration.document.reviewed — all on the
    // notifications queue. The retention sweep added retention.purge on infrastructure — the only
    // job in the system fired by a timer rather than a request.
    expect(ASYNC_JOB_REGISTRATIONS).toHaveLength(14);

    const probe = getRegistrationByJobName(ASYNC_JOB_NAMES.probePing);
    expect(probe).toBeDefined();
    expect(probe?.queueName).toBe(ASYNC_QUEUE_NAMES.infrastructure);

    const syncJob = getRegistrationByJobName(ASYNC_JOB_NAMES.competitionSearchSync);
    expect(syncJob).toBeDefined();
    expect(syncJob?.queueName).toBe(ASYNC_QUEUE_NAMES.competition);

    const resultJob = getRegistrationByJobName(ASYNC_JOB_NAMES.resultPublished);
    expect(resultJob).toBeDefined();
    expect(resultJob?.queueName).toBe(ASYNC_QUEUE_NAMES.results);

    const confirmedJob = getRegistrationByJobName(ASYNC_JOB_NAMES.registrationConfirmed);
    expect(confirmedJob).toBeDefined();
    expect(confirmedJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const cancelledJob = getRegistrationByJobName(ASYNC_JOB_NAMES.registrationCancelled);
    expect(cancelledJob).toBeDefined();
    expect(cancelledJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const finalizedJob = getRegistrationByJobName(ASYNC_JOB_NAMES.submissionFinalized);
    expect(finalizedJob).toBeDefined();
    expect(finalizedJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const competitionEditedJob = getRegistrationByJobName(ASYNC_JOB_NAMES.competitionEdited);
    expect(competitionEditedJob).toBeDefined();
    expect(competitionEditedJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const competitionCancelledJob = getRegistrationByJobName(ASYNC_JOB_NAMES.competitionCancelled);
    expect(competitionCancelledJob).toBeDefined();
    expect(competitionCancelledJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const instInviteJob = getRegistrationByJobName(ASYNC_JOB_NAMES.institutionInvitationDispatch);
    expect(instInviteJob).toBeDefined();
    expect(instInviteJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const teamInviteJob = getRegistrationByJobName(ASYNC_JOB_NAMES.teamInvitationDispatch);
    expect(teamInviteJob).toBeDefined();
    expect(teamInviteJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    // The comment above has claimed this job since it shipped, but nothing asserted it.
    const recruiterRejectedJob = getRegistrationByJobName(
      ASYNC_JOB_NAMES.recruiterVerificationRejected,
    );
    expect(recruiterRejectedJob).toBeDefined();
    expect(recruiterRejectedJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const documentRequestedJob = getRegistrationByJobName(
      ASYNC_JOB_NAMES.registrationDocumentRequested,
    );
    expect(documentRequestedJob).toBeDefined();
    expect(documentRequestedJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    const documentReviewedJob = getRegistrationByJobName(
      ASYNC_JOB_NAMES.registrationDocumentReviewed,
    );
    expect(documentReviewedJob).toBeDefined();
    expect(documentReviewedJob?.queueName).toBe(ASYNC_QUEUE_NAMES.notifications);

    // Platform maintenance belongs off the notifications queue, whose backlog users feel.
    const retentionJob = getRegistrationByJobName(ASYNC_JOB_NAMES.retentionPurge);
    expect(retentionJob).toBeDefined();
    expect(retentionJob?.queueName).toBe(ASYNC_QUEUE_NAMES.infrastructure);
  });

  it("exposes queue-level processor registrations", () => {
    expect(getRegisteredQueueNames()).toEqual(
      expect.arrayContaining([
        ASYNC_QUEUE_NAMES.infrastructure,
        ASYNC_QUEUE_NAMES.competition,
        ASYNC_QUEUE_NAMES.results,
        ASYNC_QUEUE_NAMES.notifications,
      ]),
    );
    // probe.ping + retention.purge — the latter is the one scheduled job in the system.
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.infrastructure)).toHaveLength(2);
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.competition)).toHaveLength(1);
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.results)).toHaveLength(1);
    expect(getQueueRegistrations(ASYNC_QUEUE_NAMES.notifications)).toHaveLength(10);
  });
});
