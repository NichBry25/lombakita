/*
 * A file that exists to be broken.
 *
 * Rule 36 clause 1 — a mutation must be shown to COMPILE — is itself a guard, and Rule 32 says a
 * guard is not wired until something fails when it is removed. Proving it needs a probe whose
 * mutation genuinely does not parse, and pointing that at a real module would mean a test run
 * capable of leaving the repository broken if a restore ever failed. This module is imported by
 * nothing, so the only thing that can break is the probe measuring itself.
 */
export const intact = true;
