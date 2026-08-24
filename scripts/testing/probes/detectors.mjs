/*
 * How a probe decides that a guard REFUSED, as opposed to that something merely went wrong.
 *
 * Rule 36 clause 3: a probe is evidence only if it is red for the reason claimed. Accepting any
 * non-zero exit as a refusal is that clause's own failure mode wearing the opposite sign —
 * `vitest run some/renamed.test.ts` exits 1 having run nothing, so a probe whose detector path is
 * mistyped, or whose test file is later renamed, would report itself PROVEN. A run that crashed did
 * not measure and must not be read either way.
 *
 * `browser-audit-refusals.mjs` already had the right shape: assert a SPECIFIC exit code and the
 * ABSENCE of the report a measurement would have printed. This is that shape, generalised so the
 * config gates use it rather than a second version of it.
 */
import { spawnSync } from "node:child_process";

/** Runs a command and captures both streams, so a verdict can be read off the output. */
export const run = (command, args, env = {}) =>
  spawnSync(command, args, { encoding: "utf8", env: { ...process.env, ...env } });

/**
 * A verdict from one run.
 *
 * @param result             what `run` returned
 * @param spec.status        the exact exit code a refusal produces; any non-zero when omitted
 * @param spec.reached       a pattern the output MUST carry, naming what actually failed. Its
 *                           absence THROWS rather than returning a verdict, because a run that
 *                           never reached its assertion has measured nothing.
 * @param spec.forbidden     a pattern that would mean the run measured after all, so the refusal
 *                           came too late to be one
 * @param spec.label         what this detector is watching, for the evidence line
 */
export const refusedWhen = (result, { status, reached, forbidden, label }) => {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const exitedAsExpected = status === undefined ? result.status !== 0 : result.status === status;

  if (!exitedAsExpected) {
    return {
      refused: false,
      evidence: `expected exit ${status ?? "non-zero"}, got ${result.status}: ${output.trim().slice(0, 160)}`,
    };
  }

  if (forbidden?.test(output)) {
    return {
      refused: false,
      evidence: `${label}: exited ${result.status} but ${forbidden} matched anyway — whatever it refused, it refused AFTER measuring`,
    };
  }

  if (!reached) return { refused: true, evidence: `${label}: exit ${result.status}, no report` };

  const named = output.split("\n").find((line) => reached.test(line));
  if (!named) {
    throw new Error(
      `${label}: exited ${result.status} without matching ${reached}. A run that crashed is not a ` +
        `guard that refused. Tail of its output:\n${output.slice(-600)}`,
    );
  }

  return { refused: true, evidence: `${label} went red: ${named.trim().slice(0, 140)}` };
};

/** A test runner naming which case failed, as opposed to any non-zero exit at all. */
export const TEST_FAILURE = /FAIL|✗|✘|error TS|AssertionError|Tests\s+\d+ failed/;

/**
 * Runs a command and reports whether it went red FOR AN IDENTIFIED REASON.
 *
 * `reached` is what makes this a Rule 36 clause 3 detector rather than an exit-code reader: the run
 * must name which assertion failed. Its absence throws, because a crashed detector is not a guard
 * that refused — a probe suite once reported a browser that was never installed as a guard holding.
 *
 * Lives here rather than in either probe file because both need it and neither owns it.
 */
export const fails = (command, args, reached = TEST_FAILURE) =>
  refusedWhen(run(command, args), { reached, label: `${command} ${args.join(" ")}` });
