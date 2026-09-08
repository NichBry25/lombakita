/*
 * Rule 36 probe for the fixture-recipient gate.
 *
 * EMAIL-D4 specified the simulator addresses and nothing enforced it, so the incident recurred four
 * days later. The gate is the enforcement; this is the demonstration that the gate can actually
 * fail, which is the only thing separating it from the specification that already existed.
 *
 * CLASS D. The gate is a read over declared text, judged on its RESULT CONTENT: it reports which
 * recipients are routable. A pure read has no move analogue, so there is no ordering probe and none
 * is being withheld.
 *
 * The harmful move is the one that actually happened twice: a routable recipient appearing in a
 * fixture. So the mutation introduces exactly that, rather than removing the gate's code — a gate
 * that cannot see a real violation is the failure being probed for, and deleting its body would
 * measure something weaker.
 *
 * Usage: node scripts/testing/probes/fixture-recipients.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const SEEDS = "scripts/testing/seeds.mjs";

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
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", "scripts/testing/fixture-recipients.test.ts"],
        // Names the case, so a renamed test file cannot report itself as proof.
        /is reserved or a simulator address, never routable/,
      ),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  await runProbes(probes);
}
