/*
 * Rule 36 probes for the fixture-recipient gate.
 *
 * EMAIL-D4 specified the simulator addresses and nothing enforced it, so the incident recurred four
 * days later. The gate is the enforcement; these are the demonstration that the gate can actually
 * fail, which is the only thing separating it from the specification that already existed.
 *
 * CLASS D throughout. The gate is a read over declared text, judged on its RESULT CONTENT: it
 * reports which recipients are routable and which files are undeclared. A pure read has no move
 * analogue, so there is no ordering probe in this suite and none is being withheld.
 *
 * FOUR ASSERTIONS, FOUR PROBES, one each. The recipient rule was probed from the start; the three
 * completeness assertions were shipped without one, which is precisely the "assumed, not verified"
 * shape the rule exists to stop, and two of the three were demonstrably evadable while green. Every
 * mutation below is the real harmful move rather than a deletion of the gate's own body: a gate that
 * cannot see a genuine violation is the failure being probed for, and removing its code would
 * measure something weaker.
 *
 * Usage: node scripts/testing/probes/fixture-recipients.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const SEEDS = "scripts/testing/seeds.mjs";
const DECLARATION = "scripts/testing/fixture-recipients.ts";
const CONNECTOR_PROBE = "src/server/email/probe.ts";
const PINNED_TEST = "src/server/email/delivery.test.ts";

const gate = (reached) =>
  fails("npx", ["vitest", "run", "scripts/testing/fixture-recipients.test.ts"], reached);

export const probes = [
  {
    name: "a routable recipient in a seed is caught",
    klass: "D",
    harmfulMove:
      "a fixture addressing a real, routable mailbox, so a seed run with delivery enabled mails " +
      "a person and bounces against the sending domain",
    files: [SEEDS],
    appliedMarkers: ["seed.cand.a@gmail.com"],
    mutate: () =>
      substituteOnce(
        SEEDS,
        'email: "seed.cand.a@seed.lombakita.local",',
        'email: "seed.cand.a@gmail.com",',
      ),
    // Names the case, so a renamed test file cannot report itself as proof.
    detect: async () => gate(/is reserved or a simulator address, never routable/),
  },
  {
    name: "a send-capable program nobody declared is caught",
    klass: "D",
    harmfulMove:
      "a program that can hand an address to the provider carrying a routable one while sitting " +
      "outside the governed list, which is the fail-open the completeness assertion exists to stop",
    files: [CONNECTOR_PROBE],
    appliedMarkers: ['to: "probe.victim@gmail.com",'],
    // The connector probe genuinely sends, and it lives under src/server/email rather than under
    // scripts. That location is the point: the previous discovery pass looked only at an allow list
    // of two roots, so this exact mutation passed the whole gate green.
    mutate: () =>
      substituteOnce(
        CONNECTOR_PROBE,
        '    kind: "connector_probe_http",\n    to: DELIVERED_SIMULATOR_RECIPIENT,',
        '    kind: "connector_probe_http",\n    to: "probe.victim@gmail.com",',
      ),
    detect: async () => gate(/declares every address-bearing file that can actually send/),
  },
  {
    name: "a deny entry that hides a governed file is caught",
    klass: "D",
    harmfulMove:
      "narrowing the walk until governed files fall outside it, which makes the completeness " +
      "assertion above pass over a smaller and smaller population while still reading as green",
    files: [DECLARATION],
    appliedMarkers: ['{ file: "concurrency"'],
    // Denies one directory name, which prunes scripts/concurrency and with it seven governed files.
    // Deliberately narrow: only the reverse-completeness assertion should go red, so the probe
    // cannot be satisfied by some other check failing for some other reason.
    mutate: () =>
      substituteOnce(
        DECLARATION,
        '  { file: "coverage", reason: "test output" },',
        '  { file: "coverage", reason: "test output" },\n' +
          '  { file: "concurrency", reason: "probe: a deny entry broad enough to hide governed files" },',
      ),
    detect: async () => gate(/walks every file it already governs/),
  },
  {
    name: "an address added to an existing pin entry is caught",
    klass: "D",
    harmfulMove:
      "accepting one more routable fixture by editing an entry rather than adding one, which the " +
      "per-file checks both wave through: it is pinned, so not unpinned, and it is present, so " +
      "not stale",
    files: [PINNED_TEST, DECLARATION],
    appliedMarkers: ["probe.pinned@gmail.com"],
    // Both halves in one mutation, because either alone fails a DIFFERENT assertion and would prove
    // that one instead: the address without the pin is unpinned, the pin without the address is
    // stale. Together they satisfy both, and only the total-count ratchet sees the growth.
    mutate: () => {
      substituteOnce(
        PINNED_TEST,
        "// @vitest-environment node\n",
        "// @vitest-environment node\n// probe.pinned@gmail.com\n",
      );
      substituteOnce(
        DECLARATION,
        '    addresses: ["a@b.com", "auth@lombakita.com"],',
        '    addresses: ["a@b.com", "auth@lombakita.com", "probe.pinned@gmail.com"],',
      );
    },
    detect: async () => gate(/holds exactly the debt the ceiling declares/),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  await runProbes(probes);
}
