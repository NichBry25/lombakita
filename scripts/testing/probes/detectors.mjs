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
 *
 * ONE CASE IS NOT A GUARD FAILING AND NOT A GUARD HOLDING: the runner never starting. `vitest`'s
 * orchestrator talks to its own worker over an RPC that times out on a cold Vite transform, which
 * `vitest.config.ts` already documents as the reason `testTimeout` is 15s. It surfaces as an
 * "Unhandled Error", the exit code is 1, and NO case is reported — the same exit code, and the same
 * absence of a named failure, that a mistyped test path produces. Reading it as a verdict in either
 * direction is the clause-3 failure this file exists to prevent: red would claim a guard was
 * measured, green would claim one held. It is retried ONCE, and a retry that also reports nothing
 * throws exactly as a single crashed run would, so the retry can turn a flake into a measurement and
 * can never turn a crash into a verdict.
 */
import { spawnSync } from "node:child_process";

/** Runs a command and captures both streams, so a verdict can be read off the output. */
export const run = (command, args, env = {}) =>
  spawnSync(command, args, { encoding: "utf8", env: { ...process.env, ...env } });

/**
 * Vitest's orchestrator giving up on its own worker, before any case was reported.
 *
 * Narrow on purpose: it names the worker RPC, not "Unhandled Errors" generally. An unhandled
 * rejection raised by the code under test is a real observation about that code and must stay a
 * throw.
 */
const WORKER_NEVER_STARTED = /\[vitest-worker\]: Timeout calling/;

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
 * @param spec.retry         re-runs the same command, consulted only where this call was about to
 *                           throw for want of a named failure. Omit it and a crashed run throws
 *                           immediately, which is what every caller that is not a test runner wants.
 */
export const refusedWhen = (result, { status, reached, forbidden, label, retry }) => {
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
    if (retry && WORKER_NEVER_STARTED.test(output)) {
      // The recursion is depth-one by construction: the inner call is given no `retry`, so a second
      // worker timeout reaches the throw below rather than looping.
      return refusedWhen(retry(), { status, reached, forbidden, label });
    }

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
  refusedWhen(run(command, args), {
    reached,
    label: `${command} ${args.join(" ")}`,
    retry: () => run(command, args),
  });
