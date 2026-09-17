/*
 * A stand-in for a test runner whose worker never started, so the retry in `detectors.mjs` can be
 * driven down both of its paths deterministically instead of waiting for the real flake to recur.
 *
 * Usage: node flaky-runner.mjs <marker-path> <once|always>
 *
 *   once    — the first run reports vitest's worker-RPC timeout and writes the marker; every run
 *             after it reports a named failing case. A caller that retries reaches a measurement.
 *   always  — every run reports the worker-RPC timeout. A caller that retries gets the same crash.
 *
 * Exits 1 in every case, because a worker timeout exits 1 and a failing case exits 1 — the exit code
 * is exactly the signal that cannot tell them apart, which is the whole point.
 */
import { existsSync, writeFileSync } from "node:fs";

const [marker, mode] = process.argv.slice(2);
if (!marker || (mode !== "once" && mode !== "always")) {
  throw new Error("usage: flaky-runner.mjs <marker-path> <once|always>");
}

if (mode === "once" && existsSync(marker)) {
  console.log("× a fake case > the guard held");
  process.exit(1);
}

writeFileSync(marker, "");
console.error('Error: [vitest-worker]: Timeout calling "fetch" with "["/@vite/env","ssr"]"');
process.exit(1);
