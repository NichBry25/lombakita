import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const PAID_REGISTRATION = "src/server/finance/paid-registration.ts";
const PAYMENT_EXPIRY_SERVICE = "src/server/finance/payment-expiry-service.ts";
const RECIPIENTS_TEST = "src/server/finance/payment-notice-recipients-db.integration.test.ts";

const NOT_CANCELLED_FILTER =
  '        eq(competitionRegistrations.teamId, self.teamId),\n        ne(competitionRegistrations.status, "cancelled"),\n';
const NOT_CANCELLED_FILTER_REMOVED =
  "        eq(competitionRegistrations.teamId, self.teamId),\n        sql`true`,\n";
const EXPIRY_TIME_CONDITION =
  "        eq(competitionRegistrations.cancelledAt, expiredEvent.occurredAt),\n";
const EXPIRY_TIME_CONDITION_REMOVED = "        sql`true`,\n";

const VERIFICATION_REACHED = /× .*tells a verification only to the members still in the team/;
const SECOND_EXPIRY_REACHED =
  /× .*tells the second expiry only to the rows it cancelled, not to rows the first expiry cancelled/;

// Both guards are class D: they filter a read and write nothing, so the harmful move is the filter
// being absent. A read has no move analogue, and no probe is fabricated for one. The detector is the
// recipient list that the database test reads off the job's processor.
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
    detect: async () => fails("npx", ["vitest", "run", RECIPIENTS_TEST], VERIFICATION_REACHED),
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
    detect: async () => fails("npx", ["vitest", "run", RECIPIENTS_TEST], SECOND_EXPIRY_REACHED),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("notice-recipients", [["npx", ["vitest", "run", RECIPIENTS_TEST]]]);
  await runProbes(probes);
}
