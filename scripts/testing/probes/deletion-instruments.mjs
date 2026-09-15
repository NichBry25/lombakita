/*
 * Rule 36 probes for the deletion verifier's two derivations.
 *
 * `deletion-residue.ts` exists to disagree with the deletion procedure. Every claim it makes is a
 * claim about a derivation — an attribution walk over the foreign-key graph, and a sweep over the
 * text columns. A derivation that is wrong is wrong before it is run, so both guards are provable
 * without a database and both are proved here.
 *
 * CLASS D for both — each is a pure function read for its RESULT CONTENT: the chain the walk
 * produces, and the query the sweep produces. A pure read has no move analogue, so there is no
 * ordering probe here and none is being withheld.
 *
 * WHAT THESE PROBES DO NOT COVER, stated rather than implied. The procedure's own step-removal
 * demonstration is the `blockers`, `capture-object-keys` and `capture-identities` omissions, and it
 * needs a seeded database: it lives in `run-deletion-procedure.ts --demonstrate` and its output is
 * `docs/operations/account-deletion-demonstration.md`. The two are complementary and neither
 * substitutes for the other. This file proves the verifier notices a derivation that has gone wrong;
 * that demonstration shows what a missing step leaves behind.
 *
 * Usage: node scripts/testing/probes/deletion-instruments.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const RESIDUE = "scripts/project/deletion-residue.ts";
const TEST = "scripts/project/deletion-residue.test.ts";

export const probes = [
  {
    name: "an object key on a surviving row is not counted as an object to remove",
    klass: "D",
    harmfulMove:
      "walking every foreign key instead of the CASCADE ones, so a key column on a row the deletion " +
      "leaves behind is joined in: the chain runs through the organiser who ASKED for a document " +
      "rather than the candidate who uploaded it, and the count answers zero for every account that " +
      "holds one — reported as an account holding no files",
    files: [RESIDUE],
    appliedMarkers: ['const chains = attributionChains("users", schemaForeignKeys());'],
    mutate: () =>
      substituteOnce(
        RESIDUE,
        'attributionChains("users", schemaForeignKeys(), ["cascade"])',
        'attributionChains("users", schemaForeignKeys())',
      ),
    // Anchored on the failure marker AND the case name. A bare `/object-key walk/` matches the
    // describe-block prefix on the `✓` line of a test that PASSED, so the probe reported itself red
    // while quoting a green assertion — a red for a reason other than the one claimed, which is the
    // clause this detector exists to satisfy.
    detect: async () => fails("npx", ["vitest", "run", TEST], /× .*builds each join from the chain/),
  },
  {
    name: "a value is searched for as the literal it is, not as a pattern",
    klass: "D",
    harmfulMove:
      "interpolating the person's own string into the LIKE pattern unescaped, so `_` matches any " +
      "character and `seed_rec_min` is reported at the slug `seed-rec-min`: real residue, reached by " +
      "accident, reported under a column that does not contain it, which is worse than a miss " +
      "because the reader is told a reason that is not the reason",
    files: [RESIDUE],
    appliedMarkers: ["ilike '%' || $1 || '%'"],
    mutate: () =>
      substituteOnce(RESIDUE, "ilike '%' || ${LIKE_LITERAL} || '%'", "ilike '%' || $1 || '%'"),
    detect: async () => fails("npx", ["vitest", "run", TEST], /× .*metacharacters/),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  await runProbes(probes);
}
