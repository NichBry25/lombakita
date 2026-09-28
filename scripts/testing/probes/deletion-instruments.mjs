/*
 * Rule 36 probes for the deletion verifier.
 *
 * `deletion-residue.ts` exists to disagree with the deletion procedure. Every claim it makes is a
 * claim about a derivation — an attribution walk over the foreign-key graph, and a sweep over the
 * text columns. A derivation that is wrong is wrong before it is run, and the two probes for those
 * are class D: each is a pure function read for its RESULT CONTENT, the chain the walk produces and
 * the query the sweep produces. A pure read has no move analogue, so there is no ordering probe for
 * either and none is being withheld.
 *
 * The other class here is the two guards LAUNCH-D109 found the module claiming for itself without
 * enforcing: the loopback refusal in `connect`, and the select-only check in `asBaseline`. Both are
 * class B — a refusal before anything has run, with no transaction around it — and both are reached
 * through the real CLI path rather than through an export, which is what Rule 33 asks for.
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
const SHAPE = "src/config/env-shape.ts";

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
    detect: async () =>
      fails("npx", ["vitest", "run", TEST], /× .*builds each join from the chain/),
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
  {
    name: "the delete asks the server which database it is, and refuses a protected answer",
    klass: "B",
    harmfulMove:
      "running `delete from users` behind the connection host alone. The host is the weakest of the " +
      "three refusal layers and `reset-guard.ts` says so in its own header — it may add a refusal " +
      "and never grant one — because a tunnel, a port-forward and an `/etc/hosts` line all spell " +
      "`localhost`, and this repository has already shipped a production DSN whose host and name " +
      "both read as staging (DEC-0207, LAUNCH-D24). This probe makes the local database a protected " +
      "one and requires the run to refuse on the SERVER'S OWN answer: if the identity layer is " +
      "removed, nothing refuses and the procedure proceeds to the delete",
    files: [SHAPE],
    appliedMarkers: ['production: "lombakita"'],
    mutate: () =>
      substituteOnce(SHAPE, 'production: "lombakita_production"', 'production: "lombakita"'),
    // Class B rather than D: the guard stands before a write with no transaction around it, so the
    // detector is the refusal arriving before anything ran. It quotes `current_database()` because
    // that is the layer under test — a refusal naming the connection string instead would be layer
    // 3 answering, and would pass a probe that proved nothing about layer 1.
    detect: async () =>
      fails(
        "npx",
        ["tsx", "scripts/project/run-deletion-procedure.ts", "--select", "blocked"],
        /current_database\(\) = "lombakita"/,
      ),
  },
  {
    name: "the residue verifier refuses a host that is not this machine",
    klass: "B",
    harmfulMove:
      "the verifier opening whatever DATABASE_URL names, so a run against a production host performs " +
      "the 324-column unindexed ILIKE sweep on a managed instance and writes the subject's email, " +
      "username, full name and phone number verbatim into a report file that outlives the connection " +
      "— LAUNCH-D109, where the module's own claim that it 'only reads' was doing the work a guard " +
      "should have done",
    files: [RESIDUE],
    // The removal put `connect`'s return directly after the DATABASE_URL refusal, which is a
    // sequence the file did not contain before this mutation and no other removal would produce.
    //
    // Anchored on the DATABASE_URL refusal's TAIL, not on the loopback one's. The loopback refusal
    // ends with the same `);` / `}` / blank line / return, so a marker cut there is present in the
    // unmutated file as well — clause 2's marker half then passes on a file the mutation never
    // touched, which is the failure the marker exists to catch. Only this adjacency is created by
    // the removal.
    appliedMarkers: [
      "`DATABASE_URL is not set and no env file was found (candidates: ${loadedFrom})`,\n" +
        "    );\n  }\n\n  return postgres(url, { max: 1 });",
    ],
    // The clause removed WHOLE — condition, refusal and message. Removing the message alone would
    // leave `isLoopbackUrl` deciding nothing, and removing only the `if` would leave a statement
    // that no longer refuses, which is the same experiment spelled less clearly.
    mutate: () =>
      substituteOnce(
        RESIDUE,
        [
          "  // A read-only instrument is not a safe instrument. What it reads is a person's own strings, and",
          "  // what it does with them is write them to a file that outlives the connection, so the database it",
          "  // may point at is the one on this machine and nothing else.",
          "  if (!isLoopbackUrl(url)) {",
          "    throw new ResidueRefusal(",
          '      `refusing to open ${parseDatabaseHost(url) ?? "an unparseable host"}: this instrument reads a ` +',
          '        "live account\'s own identifiers and may only do that on a loopback database",',
          "    );",
          "  }",
          "",
          "  return postgres(url, { max: 1 });",
        ].join("\n"),
        "  return postgres(url, { max: 1 });",
      ),
    // Class B rather than D: the guard sits in `connect()`, before `main` reads the baseline or asks
    // the database anything, so the detector is the refusal arriving with nothing measured. Its
    // reach is the CLI's own output — the guard is inside `connect`, and reaching it through an
    // export would prove a function rather than the wiring (Rule 33).
    detect: async () =>
      fails("npx", ["vitest", "run", TEST], /× .*refuses a database that is not on this machine/),
  },
  {
    name: "a baseline file may only carry select statements",
    klass: "B",
    harmfulMove:
      "`verify` handing `sql.unsafe` whatever an `attribution[].sql` says. The baseline is written by " +
      "`capture` but it is hand-editable and it travels between machines, so a file is executable " +
      "content: one edited line turns a read-only verifier into whatever the editor wanted, on the " +
      "loopback database the host guard permits",
    files: [RESIDUE],
    // The removal starts at the comment rather than at `const notSelect`, so the comment goes with
    // the clause it describes, and the marker is the list refusal's own last line against the
    // `return` that follows it — an adjacency the file holds nowhere else, which is what tells this
    // mutation applied from one that did not.
    appliedMarkers: ["is not a list`);\n  }\n\n  return record as ResidueBaseline;"],
    mutate: () =>
      substituteOnce(
        RESIDUE,
        [
          "  // `verify` feeds every `attribution[].sql` to `sql.unsafe`, so a baseline file is executable",
          "  // content. The file is written by `capture`, but it is also hand-editable and it travels between",
          "  // machines, and nothing else between here and `unsafe` looks at what a statement is. Every",
          "  // statement this instrument authors is a `select`; one that is not has been put there by",
          "  // something other than this instrument.",
          "  const notSelect = record.attribution.findIndex(",
          '    (entry) => typeof entry?.sql !== "string" || !/^\\s*select\\b/i.test(entry.sql),',
          "  );",
          "",
          "  if (notSelect !== -1) {",
          "    throw new ResidueRefusal(",
          "      `${where} has an \\`attribution[${notSelect}].sql\\` that is not a select statement`,",
          "    );",
          "  }",
          "",
          "  return record as ResidueBaseline;",
        ].join("\n"),
        "  return record as ResidueBaseline;",
      ),
    // Both assertions on this guard go red together, so the detector names the one built through the
    // real path: the CLI test spawns the actual `verify` on a file on disk (Rule 33), where the unit
    // test calls `parseBaselineFile` with a string it constructed itself.
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", TEST],
        /× .*refuses a non-select statement without asking the database anything/,
      ),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  await runProbes(probes);
}
