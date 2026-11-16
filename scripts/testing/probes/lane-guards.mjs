/*
 * Rule 36 probes for two guards of the manual payment lane.
 *
 * The published-to-draft refusal, CLASS B. transitionCompetitionStatus refuses published to draft
 * before it writes anything.
 * Unpublishing cancels the registrations and refuses while a transfer proof is in flight, and only
 * unpublishCompetition does both. The harmful move is a published competition written to draft with
 * a proof in flight. The refusal has no transaction around it, so a refusal moved below the status
 * write commits draft and then throws the same error: the detector is the stored state that the
 * service test reads afterwards, never the refusal alone.
 *
 * The close-extension wait, CLASS A1-IN. The close-move transaction takes the participation lock
 * and then re-reads whether a transfer awaits review, and the wait check throws inside the
 * transaction, which rolls the write back. The harmful move is the close moving while a proof sent during the extension waits for
 * review. The detector is a committing race: the extension parks on the lock, the lock holder
 * commits a proof, and the extension must be refused with the close unchanged. Moving the check
 * below the write inside the same transaction is benign, because the throw rolls the write back, so
 * it is not probed.
 *
 * The green precondition is the G1 service suite alone, which runs inside a rolled-back transaction
 * and leaves the database as it found it. The G2 race suite commits real rows and purges them by
 * marker, so it is not a gate that can be seated once for the suite. Each G2 probe's red names the
 * failing case instead, and the restored tree is shown green by the step's own test run.
 *
 * Usage: node scripts/testing/probes/lane-guards.mjs
 * Runs only over committed work. The harness refuses if any listed file differs from HEAD.
 */
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const COMPETITION_SERVICE = "src/server/competitions/competition-service.ts";
const TRANSITION_TEST =
  "src/server/competitions/competition-status-transition-db.integration.test.ts";
const RACE_TEST = "src/server/finance/manual-lane-race-db.integration.test.ts";

const TRANSITION_CASE = "refuses with a proof pending review, and the competition stays published";
const EXTENSION_CASE =
  "a proof committed while the extension waits for the lock refuses it, and the close stays";

/** A literal for embedding in a `reached` pattern, so a title containing `.` or `(` still matches. */
const regexFree = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each detector names the assertion that failed, not only the case, because a case can also fail
// for a reason that has nothing to do with the mutation. The patterns read the received side of the
// failed comparison, which is what the service returned or left stored.
const transitionCaseFailedWith = (receivedLine) =>
  fails("npx", ["vitest", "run", TRANSITION_TEST, "-t", TRANSITION_CASE], receivedLine);

const extensionCaseFailedWith = (reasonLine) =>
  fails("npx", ["vitest", "run", RACE_TEST, "-t", EXTENSION_CASE], reasonLine);

const TRANSITION_RETURNED_NO_REFUSAL = /\+\s+"refusal": null/;
const TRANSITION_LEFT_DRAFT_STORED = /\+\s+"competitionStatus": "draft"/;
const EXTENSION_NEVER_QUEUED = new RegExp(
  regexFree("the close extension never queued; it settled ok"),
);
const EXTENSION_RETURNED_NO_REFUSAL = /\+\s+"refusal": null/;

/** The refusal of published to draft, exactly as it stands in transitionCompetitionStatus. */
const PUBLISHED_TO_DRAFT_REFUSAL = [
  '  if (competition.status === "published" && targetStatus === "draft") {',
  "    throw new CompetitionError(",
  '      "competition_invalid_transition",',
  "      422,",
  '      "Unpublishing goes through unpublishCompetition, which refuses while a transfer proof is pending review or verified",',
  "    );",
  "  }",
  "",
  "",
].join("\n");

const PUBLISHED_TO_DRAFT_REFUSAL_REMOVED = "  // probe: the published-to-draft refusal is gone\n\n";

const STATUS_WRITE_RESULT_CHECK = [
  "  if (!row) {",
  "    throw new CompetitionError(",
  '      "competition_invalid_transition",',
  "      422,",
  '      "Competition status was modified concurrently — reload and retry the transition",',
].join("\n");

const PUBLISHED_TO_DRAFT_REFUSAL_MOVED =
  "  // probe: the published-to-draft refusal now runs after the status write\n" +
  PUBLISHED_TO_DRAFT_REFUSAL;

const LOCK_THEN_WAIT_CHECK = [
  "            await acquireCompetitionParticipationLock(tx, competition.id);",
  "            await assertNoTransferAwaitingReviewUnderLock(tx, competition.id);",
  "",
].join("\n");

const WAIT_CHECK_WITHOUT_LOCK = [
  "            // probe: the participation lock is not taken in the close-move transaction",
  "            await assertNoTransferAwaitingReviewUnderLock(tx, competition.id);",
  "",
].join("\n");

const WAIT_CHECK_THEN_LOCK = [
  "            await assertNoTransferAwaitingReviewUnderLock(tx, competition.id);",
  "            await acquireCompetitionParticipationLock(tx, competition.id);",
  "",
].join("\n");

export const probes = [
  {
    name: "published to draft: refusal REMOVED from transitionCompetitionStatus",
    klass: "B",
    harmfulMove:
      "a published competition written to draft through the generic transition with a proof in " +
      "flight, while its registrations stay confirmed and nobody is told. The detector is the " +
      "stored state read by the service test: still published, registration still confirmed",
    files: [COMPETITION_SERVICE],
    appliedMarkers: ["// probe: the published-to-draft refusal is gone"],
    mutate: () =>
      substituteOnce(
        COMPETITION_SERVICE,
        PUBLISHED_TO_DRAFT_REFUSAL,
        PUBLISHED_TO_DRAFT_REFUSAL_REMOVED,
      ),
    detect: async () => transitionCaseFailedWith(TRANSITION_RETURNED_NO_REFUSAL),
  },
  {
    name: "published to draft: refusal MOVED below the status write",
    klass: "B",
    harmfulMove:
      "refusing only after the status write has committed draft: the caller reads the same " +
      "competition_invalid_transition while the competition is already a draft. The transition " +
      "has no transaction around its write, so nothing rolls it back",
    files: [COMPETITION_SERVICE],
    appliedMarkers: ["// probe: the published-to-draft refusal now runs after the status write"],
    mutate: () => {
      substituteOnce(COMPETITION_SERVICE, PUBLISHED_TO_DRAFT_REFUSAL, "");
      substituteOnce(
        COMPETITION_SERVICE,
        STATUS_WRITE_RESULT_CHECK,
        PUBLISHED_TO_DRAFT_REFUSAL_MOVED + STATUS_WRITE_RESULT_CHECK,
      );
    },
    detect: async () => transitionCaseFailedWith(TRANSITION_LEFT_DRAFT_STORED),
  },
  {
    name: "close extension: participation lock REMOVED from the close-move transaction",
    klass: "A1-in",
    harmfulMove:
      "the close moving while a proof sent during the extension waits for review. Without the lock " +
      "the extension never parks, so a proof committed by the lock holder cannot be seen. The " +
      "detector is the committing race: the barrier times out and the extension settled ok, so an " +
      "extension that failed for another reason is not read as the lock gap",
    files: [COMPETITION_SERVICE],
    appliedMarkers: ["// probe: the participation lock is not taken in the close-move transaction"],
    mutate: () =>
      substituteOnce(COMPETITION_SERVICE, LOCK_THEN_WAIT_CHECK, WAIT_CHECK_WITHOUT_LOCK),
    detect: async () => extensionCaseFailedWith(EXTENSION_NEVER_QUEUED),
  },
  {
    name: "close extension: transfer-review read MOVED above the participation lock",
    klass: "A1-in",
    harmfulMove:
      "reading whether a transfer awaits review before the lock is held, so a proof committed " +
      "while the extension waits for the lock is not seen and the close moves with the proof " +
      "pending review. The detector is the committing race: refusal competition_close_waits_for_" +
      "transfer_review and registration_end_at unchanged",
    files: [COMPETITION_SERVICE],
    appliedMarkers: [WAIT_CHECK_THEN_LOCK],
    mutate: () => substituteOnce(COMPETITION_SERVICE, LOCK_THEN_WAIT_CHECK, WAIT_CHECK_THEN_LOCK),
    detect: async () => extensionCaseFailedWith(EXTENSION_RETURNED_NO_REFUSAL),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("lane-guards", [["npx", ["vitest", "run", TRANSITION_TEST]]]);
  await runProbes(probes);
}
