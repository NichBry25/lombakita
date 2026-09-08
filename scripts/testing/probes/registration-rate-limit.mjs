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
 * BOTH DIRECTIONS, per Rule 32. Removal proves the guard is what refuses; the move proves it refuses
 * BEFORE the account is created and the send is billed. A gate that only passes the removal probe
 * can still sit below the write it is supposed to prevent.
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
const REACHED_REGISTER = /× .*refuses over the limit WITHOUT creating the account/;
const REACHED_RESEND_IP = /× .*refuses on the IP bound without billing a send/;
const REACHED_RESEND_ADDRESS = /× .*refuses on the address bound without billing a send/;

export const probes = [
  {
    name: "register: the IP bound is what refuses",
    klass: "C",
    harmfulMove:
      "the limiter running but never refusing, so registration stays unbounded while appearing " +
      "to be rate limited",
    files: [REGISTER],
    appliedMarkers: ["if (rate.allowed && !rate.allowed)"],
    // Keeps `rate` read, so the mutation compiles and only the refusal is removed.
    mutate: () =>
      substituteOnce(REGISTER, "if (!rate.allowed) {", "if (rate.allowed && !rate.allowed) {"),
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_REGISTER),
  },
  {
    name: "register: the bound refuses BEFORE the account is created",
    klass: "C",
    harmfulMove:
      "the refusal sitting below registerUserWithCredentials, so an over-limit caller still " +
      "creates the account and bills the verification send, and is merely told it did not",
    files: [REGISTER],
    appliedMarkers: [
      "const result = await registerUserWithCredentials(payload);\n    if (!rate.allowed)",
    ],
    mutate: () => {
      substituteOnce(
        REGISTER,
        `  if (!rate.allowed) {
    return rateLimitedResponse(rate.retryAfterSeconds);
  }

`,
        "",
      );
      substituteOnce(
        REGISTER,
        "    const result = await registerUserWithCredentials(payload);",
        `    const result = await registerUserWithCredentials(payload);
    if (!rate.allowed) {
      return rateLimitedResponse(rate.retryAfterSeconds);
    }`,
      );
    },
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_REGISTER),
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
    name: "resend: the bound refuses BEFORE the send is billed",
    klass: "C",
    harmfulMove:
      "the refusal sitting below resendRegistrationVerification, so the provider send is paid " +
      "for and the reputation spent before the caller is told it was refused",
    files: [RESEND],
    appliedMarkers: ["await resendRegistrationVerification(payload);\n\n    if (!ipRate.allowed)"],
    mutate: () => {
      substituteOnce(
        RESEND,
        `  if (!ipRate.allowed) {
    return rateLimitedResponse(ipRate.retryAfterSeconds);
  }

`,
        "",
      );
      substituteOnce(
        RESEND,
        "    const result = await resendRegistrationVerification(payload);",
        `    const result = await resendRegistrationVerification(payload);

    if (!ipRate.allowed) {
      return rateLimitedResponse(ipRate.retryAfterSeconds);
    }`,
      );
    },
    detect: async () => fails("npx", ["vitest", "run", TEST], REACHED_RESEND_IP),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  await runProbes(probes);
}
