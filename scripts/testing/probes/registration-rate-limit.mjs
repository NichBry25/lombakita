/*
 * Rule 36 probes for the two registration send paths' rate limiting.
 *
 * Both endpoints were behind no limiter in either family and there is no middleware above them, so
 * `resendRegistrationVerification` would mint a token and bill a provider send per unauthenticated
 * request, without bound.
 *
 * CLASS C — route gates. The detector is that the SERVICE IS NOT CALLED, never the status code
 * alone: a gate that answers 429 after doing the work it exists to prevent produces exactly the same
 * status as one that works, and Rule 32 exists because that is the shape people ship.
 *
 * FOUR GUARDS, BOTH DIRECTIONS EACH, WHICH IS EIGHT PROBES. Removal proves the guard is what
 * refuses; the move proves it refuses BEFORE the account is created and the send is billed. A gate
 * that only passes the removal probe can still sit below the write it is supposed to prevent. Two
 * pairs were missing when this file first shipped — the resend IP bound had no removal probe and the
 * resend address bound had no move probe — so each of those guards was half evidenced and read as
 * fully covered.
 *
 * EACH PROBE'S DETECTOR NAMES A CASE THAT ISOLATES ONE BOUND. The tests refuse a single limiter call
 * and allow the rest; if a case refused every call, neutering one bound would still produce a 429
 * from the other and the probe would pass over a guard that had stopped working.
 *
 * Usage: node scripts/testing/probes/registration-rate-limit.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const REGISTER = "src/app/api/v1/auth/register/route.ts";
const RESEND = "src/app/api/v1/auth/register/resend/route.ts";

const TEST = "src/app/api/v1/auth/registration-rate-limit.test.ts";

/**
 * One pattern per probe, each naming the single case that probe claims to break.
 *
 * A shared pattern across all four was wrong twice over: it let a probe cite a line belonging to a
 * different route's case, and — because `refusedWhen` reports the FIRST matching line — one probe
 * printed a PASSING case as its evidence. A detector that cannot say which assertion failed has not
 * met clause 3, whatever exit code it read.
 */
const REACHED_REGISTER_IP = /× .*refuses on the IP bound without creating the account/;
const REACHED_REGISTER_ADDRESS = /× .*refuses on the address bound without creating the account/;
const REACHED_RESEND_IP = /× .*refuses on the IP bound without billing a send/;
const REACHED_RESEND_ADDRESS = /× .*refuses on the address bound without billing a send/;

/**
 * The refusal each guard owns, as it appears in the route.
 *
 * Both routes reach their IP bound through `checkClientIpBound` and both reach their address bound
 * through the same limiter call, so each pair is one shape rather than two — which is what lets a
 * single move helper drive all four move probes.
 */
const IP_REFUSAL = `  if (!ipRate.allowed) {
    return rateLimitedResponse(ipRate.retryAfterSeconds);
  }`;

const ADDRESS_REFUSAL = `    if (!addressRate.allowed) {
      return rateLimitedResponse(addressRate.retryAfterSeconds);
    }`;

const REGISTER_SERVICE = "    const result = await registerUserWithCredentials(payload);";
const RESEND_SERVICE = "    const result = await resendRegistrationVerification(payload);";

/**
 * Moves a refusal below the call it exists to prevent, which is the harmful move for a class C gate.
 *
 * Deleted from its own position first, so the probe cannot pass on a route that simply gained a
 * second copy of the check while keeping the original one above the write.
 */
const moveRefusalBelow = (file, refusal, serviceCall) => {
  substituteOnce(file, `${refusal}\n`, "");
  substituteOnce(file, serviceCall, `${serviceCall}\n${refusal}`);
};

export const probes = [
  {
    name: "register: the IP bound is what refuses",
    klass: "C",
    harmfulMove:
      "the limiter running but never refusing, so registration stays unbounded while appearing " +
      "to be rate limited",
    files: [REGISTER],
    appliedMarkers: ["if (ipRate.allowed && !ipRate.allowed)"],
    // Keeps `ipRate` read, so the mutation compiles and only the refusal is removed.
    mutate: () =>
      substituteOnce(
        REGISTER,
        "if (!ipRate.allowed) {",
        "if (ipRate.allowed && !ipRate.allowed) {",
      ),
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_REGISTER_IP),
  },
  {
    name: "register: the IP bound refuses BEFORE the account is created",
    klass: "C",
    harmfulMove:
      "the refusal sitting below registerUserWithCredentials, so an over-limit caller still " +
      "creates the account and bills the verification send, and is merely told it did not",
    files: [REGISTER],
    appliedMarkers: [
      "const result = await registerUserWithCredentials(payload);\n  if (!ipRate.allowed)",
    ],
    mutate: () => moveRefusalBelow(REGISTER, IP_REFUSAL, REGISTER_SERVICE),
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_REGISTER_IP),
  },
  {
    name: "register: the address bound is what refuses",
    klass: "C",
    harmfulMove:
      "the per-address bound running but never refusing, so a caller rotating IPs can have the " +
      "platform mail one person without limit through the signup endpoint",
    files: [REGISTER],
    appliedMarkers: ["if (addressRate.allowed && !addressRate.allowed)"],
    mutate: () =>
      substituteOnce(
        REGISTER,
        "if (!addressRate.allowed) {",
        "if (addressRate.allowed && !addressRate.allowed) {",
      ),
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_REGISTER_ADDRESS),
  },
  {
    name: "register: the address bound refuses BEFORE the account is created",
    klass: "C",
    harmfulMove:
      "the address refusal sitting below registerUserWithCredentials, so the victim is mailed " +
      "and the account written before the caller is told the address was over its budget",
    files: [REGISTER],
    appliedMarkers: [
      "const result = await registerUserWithCredentials(payload);\n    if (!addressRate.allowed)",
    ],
    mutate: () => moveRefusalBelow(REGISTER, ADDRESS_REFUSAL, REGISTER_SERVICE),
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_REGISTER_ADDRESS),
  },
  {
    name: "resend: the IP bound is what refuses",
    klass: "C",
    harmfulMove:
      "the IP bound running but never refusing, leaving a single host free to sweep the endpoint " +
      "at whatever rate it likes",
    files: [RESEND],
    appliedMarkers: ["if (ipRate.allowed && !ipRate.allowed)"],
    mutate: () =>
      substituteOnce(RESEND, "if (!ipRate.allowed) {", "if (ipRate.allowed && !ipRate.allowed) {"),
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_RESEND_IP),
  },
  {
    name: "resend: the IP bound refuses BEFORE the send is billed",
    klass: "C",
    harmfulMove:
      "the refusal sitting below resendRegistrationVerification, so the provider send is paid " +
      "for and the reputation spent before the caller is told it was refused",
    files: [RESEND],
    appliedMarkers: [
      "const result = await resendRegistrationVerification(payload);\n  if (!ipRate.allowed)",
    ],
    mutate: () => moveRefusalBelow(RESEND, IP_REFUSAL, RESEND_SERVICE),
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_RESEND_IP),
  },
  {
    name: "resend: the address bound is what refuses",
    klass: "C",
    harmfulMove:
      "the per-address bound running but never refusing, leaving a distributed caller free to " +
      "have the platform mail one person indefinitely",
    files: [RESEND],
    appliedMarkers: ["if (addressRate.allowed && !addressRate.allowed)"],
    mutate: () =>
      substituteOnce(
        RESEND,
        "if (!addressRate.allowed) {",
        "if (addressRate.allowed && !addressRate.allowed) {",
      ),
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_RESEND_ADDRESS),
  },
  {
    name: "resend: the address bound refuses BEFORE the send is billed",
    klass: "C",
    harmfulMove:
      "the address refusal sitting below resendRegistrationVerification, so the victim receives " +
      "the mail the bound exists to stop and the caller is told it was refused",
    files: [RESEND],
    appliedMarkers: [
      "const result = await resendRegistrationVerification(payload);\n    if (!addressRate.allowed)",
    ],
    mutate: () => moveRefusalBelow(RESEND, ADDRESS_REFUSAL, RESEND_SERVICE),
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_RESEND_ADDRESS),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  await runProbes(probes);
}
