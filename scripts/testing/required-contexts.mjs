/*
 * WHICH CI JOBS MUST BLOCK A MERGE.
 *
 * Running is not gating. Both jobs in `ci.yml` ran on every pull request for weeks while branch
 * protection required one of them, so a pull request whose mobile audit exited 1 on a fresh
 * overflow, or whose preflight exited 3 having measured nothing, was still mergeable. The list
 * below is the declaration of which display names branch protection is expected to hold; the pins
 * in `src/config/ci-gates.test.ts` check it against the jobs that actually exist, and
 * `verify-branch-protection.mjs` checks it against GitHub.
 *
 * Branch protection matches a job by its DISPLAY NAME, not its id, which is why a rename here is
 * not cosmetic: renaming a job without renaming its context leaves a required check that can never
 * report, and a pull request that can never merge.
 */
export const REQUIRED_CONTEXTS = ["lint, typecheck, test", "browser audits"];

/**
 * Every job's display name, in the order `ci.yml` declares them.
 *
 * Read from the workflow's text rather than a parsed document, matching the choice its only other
 * reader already made for the same reason: a handful of exact strings does not justify a YAML
 * dependency this repository otherwise has no use for.
 */
export const jobDisplayNames = (workflow) => {
  const jobs = [];
  let insideJobs = false;

  for (const line of workflow.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      insideJobs = true;
      continue;
    }
    if (!insideJobs) continue;
    // Any key back at column zero ends the jobs block.
    if (/^\S/.test(line)) break;

    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      jobs.push({ id: header[1], name: null });
      continue;
    }

    // A job's own `name` sits at four spaces. A step's sits at six behind a dash, and a service's
    // keys deeper still, so neither can be mistaken for one here.
    const named = /^ {4}name: (.+?)\s*$/.exec(line);
    if (named && jobs.length > 0 && jobs[jobs.length - 1].name === null) {
      jobs[jobs.length - 1].name = named[1];
    }
  }

  // GitHub shows the job id when a job declares no name, and branch protection matches whichever
  // it ends up showing.
  return jobs.map((job) => job.name ?? job.id);
};
