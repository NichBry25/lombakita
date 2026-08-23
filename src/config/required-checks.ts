/**
 * The CI checks that must pass before anything reaches `main`.
 *
 * This list is the EXPECTATION. GitHub holds the reality, in the branch protection rule's
 * `required_status_checks.contexts`, and the two are compared by
 * `scripts/verify/required-checks.mjs` — which needs an authenticated admin call and therefore
 * cannot run inside the pull request's own workflow.
 *
 * It exists because the two drifted, silently and expensively. `browser audits` ran on every pull
 * request, reported its findings, and could not block a merge — while three artifacts in the same
 * change asserted that it gated. A workflow step is not a gate until protection names it, and a
 * name only keeps naming it while the job's display name stays the same, which is what the test
 * beside this file pins.
 */
export const REQUIRED_STATUS_CHECKS = ["lint, typecheck, test", "browser audits"] as const;
