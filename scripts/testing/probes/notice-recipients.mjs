import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const PAID_REGISTRATION = "src/server/finance/paid-registration.ts";
const PAYMENT_EXPIRY_SERVICE = "src/server/finance/payment-expiry-service.ts";
const PAYMENT_OUTCOME_JOB = "src/server/async/jobs/payment-outcome.ts";
const RECIPIENTS_TEST = "src/server/finance/payment-notice-recipients-db.integration.test.ts";

const VERIFICATION_CASE = "tells a verification only to the members still in the team";
const REJECTION_CASE = "gives a rejection reason only to the members still in the team";
const INDIVIDUAL_CASE =
  "tells the single payer, with or without a carried list, even after the row is cancelled";
const SECOND_EXPIRY_CASE =
  "tells the second expiry only to the rows it cancelled, not to rows the first expiry cancelled";

const NOT_CANCELLED_FILTER =
  '        eq(competitionRegistrations.teamId, self.teamId),\n        ne(competitionRegistrations.status, "cancelled"),\n';
const NOT_CANCELLED_FILTER_REMOVED =
  "        eq(competitionRegistrations.teamId, self.teamId),\n        sql`true`,\n";
const EXPIRY_TIME_CONDITION =
  "        eq(competitionRegistrations.cancelledAt, expiredEvent.occurredAt),\n";
const EXPIRY_TIME_CONDITION_REMOVED = "        sql`true`,\n";

const CARRIED_LIST_BRANCH =
  "  if (payload.recipientUserIds !== undefined) return payload.recipientUserIds;\n";
const CARRIED_LIST_BRANCH_IGNORED = "  // probe: the carried list is ignored\n";

const INDIVIDUAL_PAYER_BRANCH = "  if (self.teamId === null) return [self.studentId];\n";
const INDIVIDUAL_PAYER_BRANCH_DROPPED =
  "  // probe: the individual payer is dropped\n  if (self.teamId === null) return [];\n";

const caseFailedWith = (caseName, receivedLine) =>
  fails("npx", ["vitest", "run", RECIPIENTS_TEST, "-t", caseName], receivedLine);

// Each detector names the assertion that failed, not only the case, because a case can also fail for
// a reason that has nothing to do with the mutation. The patterns read the received side of the
// failed comparison.
const LEAVER_WAS_TOLD = /\+\s+"leaverInbox": 1/;
const SECOND_EXPIRY_REACHED_THREE_ROWS = /\+\s+"secondNoticeCount": 3/;
const INDIVIDUAL_PAYER_CARRIED_NOBODY = /\+\s+"carried": \[\],?/;

// Every guard is class D: it filters or selects a read and writes nothing, so the harmful move is the
// filter or the selection being absent. A read has no move analogue, and no probe is fabricated for
// one. The detector is the recipient list that the database test reads off the job's processor.
// The call sites of notifyPaymentOutcome need no probe: a verdict caller that drops its list fails
// typecheck, which makes the ordering a compile error.
export const probes = [
  {
    name: "notice recipients: the not-cancelled filter of a team verdict REMOVED",
    klass: "D",
    harmfulMove:
      "naming a member whose row was cancelled before the verdict as a recipient of its notice and its reason",
    files: [PAID_REGISTRATION],
    appliedMarkers: [NOT_CANCELLED_FILTER_REMOVED],
    mutate: () =>
      substituteOnce(PAID_REGISTRATION, NOT_CANCELLED_FILTER, NOT_CANCELLED_FILTER_REMOVED),
    detect: async () => caseFailedWith(VERIFICATION_CASE, LEAVER_WAS_TOLD),
  },
  {
    name: "notice recipients: the cancelled_at time condition of an expiry REMOVED",
    klass: "D",
    harmfulMove:
      "naming a row that an earlier expiry or a withdrawal cancelled as a recipient of this expiry's notice",
    files: [PAYMENT_EXPIRY_SERVICE],
    appliedMarkers: [EXPIRY_TIME_CONDITION_REMOVED],
    mutate: () =>
      substituteOnce(PAYMENT_EXPIRY_SERVICE, EXPIRY_TIME_CONDITION, EXPIRY_TIME_CONDITION_REMOVED),
    detect: async () => caseFailedWith(SECOND_EXPIRY_CASE, SECOND_EXPIRY_REACHED_THREE_ROWS),
  },
  {
    name: "notice recipients: the job's carried list IGNORED",
    klass: "D",
    harmfulMove:
      "a member who left before a rejection is given the organiser's reason, because the job reads the whole group at delivery",
    files: [PAYMENT_OUTCOME_JOB],
    appliedMarkers: [CARRIED_LIST_BRANCH_IGNORED],
    mutate: () =>
      substituteOnce(PAYMENT_OUTCOME_JOB, CARRIED_LIST_BRANCH, CARRIED_LIST_BRANCH_IGNORED),
    detect: async () => caseFailedWith(REJECTION_CASE, LEAVER_WAS_TOLD),
  },
  {
    name: "notice recipients: the individual payer DROPPED",
    klass: "D",
    harmfulMove: "an individual payer is told nothing about the verdict on their own payment",
    files: [PAID_REGISTRATION],
    appliedMarkers: ["// probe: the individual payer is dropped"],
    mutate: () =>
      substituteOnce(PAID_REGISTRATION, INDIVIDUAL_PAYER_BRANCH, INDIVIDUAL_PAYER_BRANCH_DROPPED),
    detect: async () => caseFailedWith(INDIVIDUAL_CASE, INDIVIDUAL_PAYER_CARRIED_NOBODY),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("notice-recipients", [["npx", ["vitest", "run", RECIPIENTS_TEST]]]);
  await runProbes(probes);
}
