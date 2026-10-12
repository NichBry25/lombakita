import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const FILE = "src/server/auth/session.ts";
const TEST = "src/server/auth/session.test.ts";
const TRIPWIRE = "src/server/auth/unsatisfied-mfa-opt-out.test.ts";
const GUARD =
  "  if (!options?.allowUnsatisfiedMfa) {\n    assertMfaSatisfiedForOperationalSession(session);\n  }\n";
const RETURN = "  return session;\n";
const REACHED =
  /× .*competition GET through the real session guard > refuses before every reader for ['"]platform_ops['"] with ['"]enrolment_required['"]/;
const detect = async () => fails("npx", ["vitest", "run", TEST, TRIPWIRE], REACHED);

export const probes = [
  {
    name: "requireAuthenticatedSession: operational MFA call REMOVED",
    klass: "C",
    harmfulMove: "returning an unsatisfied operational session permits the competition reader",
    files: [FILE],
    appliedMarkers: ["  void session;"],
    mutate: () => substituteOnce(FILE, GUARD, "  void session;\n"),
    detect,
  },
  {
    name: "requireAuthenticatedSession: operational MFA call MOVED after return",
    klass: "C",
    harmfulMove:
      "the returned session reaches the competition reader before unreachable MFA refusal",
    files: [FILE],
    appliedMarkers: [RETURN + GUARD],
    mutate: () => {
      substituteOnce(FILE, GUARD, "");
      substituteOnce(FILE, RETURN, RETURN + GUARD);
    },
    detect,
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("session-mfa-default", [["npx", ["vitest", "run", TEST, TRIPWIRE]]]);
  await runProbes(probes);
}
