/*
 * Rule 36 probe for the procedure document's residue section.
 *
 * The grouping test in `deletion-procedure.test.ts` derives its groups twice over: once from the
 * census (`survivingPersonalColumns`) and once from the document's own prose, and the claim the two
 * are compared to make is that every surviving table lands in exactly one of the three groups. That
 * is the claim the removed "Survives in part" group used to carry, and it is what an operator relies
 * on when they hold a live request and go looking for a table's residue.
 *
 * CLASS D. The guard is read-only: it asserts the CONTENT of a document against a derived
 * population, so there is no call to move and no throw to relocate, and none of the A1/A2/B/C probe
 * shapes describes it. What is measured here is whether the assertion is WIRED — that a table the
 * section lists and no group claims is refused rather than reported as a complete residue.
 *
 * The mutation edits the DOCUMENT, which is a git repository in its own right (Rule 26), so the
 * probe declares `repo: "docs"` and the harness restores from that repository. Restoring from the
 * product one instead would find the file ignored, report it clean, and leave the mutation on disk.
 *
 * Usage: node scripts/testing/probes/deletion-residue-section.mjs
 * Runs only over committed work — the harness refuses if the listed file differs from HEAD.
 */
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const PROCEDURE = "docs/operations/account-deletion-procedure.md";
const TEST = "scripts/project/deletion-procedure.test.ts";

export const probes = [
  {
    name: "a surviving table the section lists is under none of the three groups",
    klass: "D",
    harmfulMove:
      "dropping a surviving personal-column table from the group it was listed under, while leaving " +
      "its row in the residue table: the section then reads as complete over a table it silently " +
      "dropped, and the operator holding a live request has a table whose residue the section never " +
      'explains — the shape the removed "Survives in part" group left behind',
    files: [PROCEDURE],
    repo: "docs",
    appliedMarkers: ["- **Never reached by the deletion (10):** `competition_rounds`"],
    mutate: () =>
      substituteOnce(
        PROCEDURE,
        "**Never reached by the deletion (10):** `competition_prizes`, `competition_rounds`",
        "**Never reached by the deletion (10):** `competition_rounds`",
      ),
    // Anchored on the assertion's own sentence, not on a bare failing-case marker: the case name
    // alone would also match the group-by-group comparison two assertions below, which is a
    // different guard and would report this one red for a reason it did not observe.
    detect: async () =>
      fails("npx", ["vitest", "run", TEST], /a surviving table is in none of the three groups/),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  await runProbes(probes);
}
