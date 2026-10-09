import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const ROUTE = "src/app/api/v1/competitions/[competitionId]/registrations/[registrationId]/route.ts";
const ROUTE_TEST =
  "src/app/api/v1/competitions/[competitionId]/registrations/[registrationId]/route.test.ts";
const REFUSAL_REACHED = /× .*refuses a mismatched expected user before calling cancelRegistration/;
const SESSION_GUARD = "    assertSessionMatchesExpectedUser(request, session);\n";
const CANCELLATION_TAIL = "      cancellationReason,\n    );\n";

export const probes = [
  {
    name: "registration cancel: session match guard REMOVED",
    klass: "C",
    harmfulMove: "calling cancelRegistration for a form submitted under another user's session",
    files: [ROUTE],
    appliedMarkers: ["    void assertSessionMatchesExpectedUser;"],
    mutate: () =>
      substituteOnce(ROUTE, SESSION_GUARD, "    void assertSessionMatchesExpectedUser;\n"),
    detect: async () => fails("npx", ["vitest", "run", ROUTE_TEST], REFUSAL_REACHED),
  },
  {
    name: "registration cancel: session match guard MOVED after cancelRegistration",
    klass: "C",
    harmfulMove: "refusing the mismatched session only after cancelRegistration has run",
    files: [ROUTE],
    appliedMarkers: [CANCELLATION_TAIL + SESSION_GUARD],
    mutate: () => {
      substituteOnce(ROUTE, SESSION_GUARD, "");
      substituteOnce(ROUTE, CANCELLATION_TAIL, CANCELLATION_TAIL + SESSION_GUARD);
    },
    detect: async () => fails("npx", ["vitest", "run", ROUTE_TEST], REFUSAL_REACHED),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("registration-cancel-session", [
    ["npx", ["vitest", "run", ROUTE_TEST]],
  ]);
  await runProbes(probes);
}
