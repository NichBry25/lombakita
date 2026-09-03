// @vitest-environment node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// THE PLATFORM DOES NOT OWN THE `.id` DOMAIN FOR THIS NAME. It owns `lombakita.com`.
//
// A support address nobody can receive mail at is worse than no address: it tells a suspended
// user they have a way to appeal and then drops what they send. The suspension page carried one
// for months, and so did the site header's accessible name, because nothing was looking.
//
// The fixture half is the same defect with a different bill. Fixture addresses at domains the
// platform does not control produce hard bounces, and a run of hard bounces is charged to the
// SENDING domain rather than to the environment that produced them. Fixtures belong at the
// reserved, non-routable TLDs `reserved-recipients.ts` already refuses to send to.
//
// The needle is ASSEMBLED FROM PARTS rather than written out, so this file does not contain the
// literal it searches for. That is what lets the check cover its own source along with everything
// else, instead of carrying an exclusion that would also hide a real occurrence added here later.
//
// The constraint reaches THE PROSE ABOVE as well, which is not obvious and was learned the hard
// way: this comment block named the domain outright, the check found it the moment the file was
// first committed, and until then the suite had reported green over a file `git ls-files` did not
// list. Describe the domain, never spell it.

const UNOWNED_DOMAIN = ["lombakita", "id"].join(".");

// A trailing letter, digit or dash means the match is a longer label (`lombakita.identity`) and
// not the domain. Anything else, including end of line, is the domain itself.
const UNOWNED_DOMAIN_PATTERN = new RegExp(
  `${UNOWNED_DOMAIN.replace(".", "\\.")}(?![a-z0-9-])`,
  "i",
);

// THE WHOLE TRACKED REPOSITORY, not just the application source. The address is as damaging in a
// workflow file, a manifest or a redirect rule as it is in a page, and limiting the scan to `src`
// and `scripts` left every root config file, `.github/`, `public/` and the migrations unwatched —
// a check whose reach was narrower than its name. `git ls-files` does the excluding, so build
// output and ignored paths stay out by construction.
const SCANNED_ROOTS = ["."] as const;

/**
 * Every committed file under the scanned roots.
 *
 * `git ls-files` rather than a directory walk: it resolves the same view of the repository that
 * `git add` does, so build output, `node_modules` and ignored paths are excluded by construction
 * rather than by an exclusion list here that would drift.
 *
 * The cost of that choice, stated because it is invisible otherwise: a file that has never been
 * committed is not listed, so a new file can carry the domain and pass locally until it is added.
 * CI always runs over committed work, so the gate itself has no gap; a local green on a worktree
 * full of new files does.
 *
 * WHAT THIS CHECK CANNOT CATCH, stated rather than left to be discovered. It is a per-line text
 * scan, so any SPLIT form defeats it: `"lombakita" + ".id"`, a template expression between the
 * halves, or the two halves landing on different lines after a formatter wraps them. That is not
 * an oversight to be fixed later — no text scan can close it — and this file uses the technique
 * deliberately, three lines below, so that it does not match itself. It is also blind to the doc
 * lane, which is a separate repository this one cannot see, and to anything not yet committed.
 */
const listTrackedFiles = (): string[] => {
  const result = spawnSync("git", ["ls-files", "--", ...SCANNED_ROOTS], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`git ls-files could not be run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ls-files exited ${result.status}: ${result.stderr.trim()}`);
  }

  return result.stdout.split("\n").filter((line) => line.length > 0);
};

const findOccurrences = (files: string[]): string[] => {
  const hits: string[] = [];

  for (const file of files) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      // A listed path that cannot be read is not evidence of cleanliness. Skipping it silently
      // is the fail-open move this check exists to avoid, so it is reported as a hit.
      hits.push(`${file}: could not be read`);
      continue;
    }

    contents.split("\n").forEach((line, index) => {
      if (UNOWNED_DOMAIN_PATTERN.test(line)) {
        hits.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  return hits;
};

describe(`no tracked file references the unowned domain`, () => {
  const files = listTrackedFiles();

  it("scanned a population large enough to be the real one", () => {
    // Without this, a broken `git ls-files` invocation returning nothing would make the
    // assertion below pass over zero files and report the repository clean.
    expect(
      files.length,
      "git ls-files returned almost nothing for the repository, so the scan below would " +
        "pass without having read the repository. Fix the invocation rather than the threshold.",
    ).toBeGreaterThan(100);
  });

  it("finds the domain when it is present, so a clean run means something", () => {
    // The detector, proven against a string built the same way the scan reads a line. A check
    // whose matcher is broken reports every repository clean, and this is the cheapest place to
    // notice that.
    expect(UNOWNED_DOMAIN_PATTERN.test(`const SUPPORT = "dukungan@${UNOWNED_DOMAIN}";`)).toBe(true);
    expect(UNOWNED_DOMAIN_PATTERN.test(`https://${UNOWNED_DOMAIN}/competitions`)).toBe(true);
    // The owned domain and the reserved fixture domain must not trip it, or the check would be
    // unfixable and would simply be deleted by whoever hit it next.
    expect(UNOWNED_DOMAIN_PATTERN.test("dukungan@lombakita.com")).toBe(false);
    expect(UNOWNED_DOMAIN_PATTERN.test("candidate-01@seed.lombakita.local")).toBe(false);
  });

  it("references it nowhere in any tracked file", () => {
    const hits = findOccurrences(files);

    expect(
      hits,
      `The platform does not own ${UNOWNED_DOMAIN}; it owns lombakita.com. Mail sent to an ` +
        `address there is never received, and fixture addresses at domains the platform does ` +
        `not control produce hard bounces charged to the real sending domain. Use ` +
        `COMPANY.supportEmail from @/config/company for anything a user reads, and the reserved ` +
        `fixture pattern (@seed.lombakita.local) for test data.\n\nFound in:\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
