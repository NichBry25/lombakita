/*
 * Rule 36 probe for the gate on the payer's QRIS.
 *
 * `loadCandidatePaymentView` hands a signed link to the organiser's QRIS only to a payer who can still
 * send a proof. Everyone else the view is returned to (a teammate who is not the payer, a payer
 * whose proof is with the organiser, a payer barred from resending) must get "hidden" and no link,
 * because a second transfer has no row, no proof control and no record on the platform.
 *
 * CLASS D. The gate is a read: nothing is written and nothing is rolled back, so there is no
 * post-state and no refusal to identify. What the mutation changes is the CONTENT of the value the
 * view returns, and the detector reads that value for a teammate. A read has no move analogue (a
 * gate placed after the signing call returns the same value), so no second probe is cut.
 *
 * The detector is the database-backed view suite, which builds the payment, the proof and the
 * teammate through the real services (Rule 33). Its tests run inside a rolled-back transaction, so
 * running it as the green precondition leaves the database as it found it.
 *
 * Usage: node scripts/testing/probes/qris-payer-gate.mjs
 * Runs only over committed work. The harness refuses if any listed file differs from HEAD.
 */
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const VIEW = "src/server/finance/candidate-payment-view.ts";
const VIEW_TEST = "src/server/finance/candidate-payment-qris-db.integration.test.ts";
const GATE = '  if (!viewerCanSendProof) return { kind: "hidden" };\n';
const GATE_REMOVED = "  void viewerCanSendProof;\n";
const TEAMMATE_CASE_REACHED = /× .*hides it from a teammate who is not the payer/;

export const probes = [
  {
    name: "qris payer gate: uploadable gate REMOVED from the QRIS state",
    klass: "D",
    harmfulMove:
      "a teammate who is not the payer, given a signed link to the organiser's QRIS by the " +
      "candidate payment view. The detector reads the value the view returns for that teammate",
    files: [VIEW],
    appliedMarkers: [GATE_REMOVED],
    mutate: () => substituteOnce(VIEW, GATE, GATE_REMOVED),
    detect: async () => fails("npx", ["vitest", "run", VIEW_TEST], TEAMMATE_CASE_REACHED),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("qris-payer-gate", [["npx", ["vitest", "run", VIEW_TEST]]]);
  await runProbes(probes);
}
