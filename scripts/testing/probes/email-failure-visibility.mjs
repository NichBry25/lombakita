/*
 * Rule 36 probes for the outbound-email failure classification Block B adds.
 *
 * The thing being closed is that a 403 from Resend was indistinguishable from a network blip: every
 * send site flattened the provider's response into `new Error(message)`, so the status and the
 * provider code were gone before anybody could act on them. Two guards now stand where that used to
 * be, and each is probed by breaking its premise and requiring the tests over it to go RED.
 *
 * BOTH ARE CLASS D. They are pure functions read for their RESULT CONTENT: one maps a provider
 * response to a failure class, the other maps a failure class to the words a person reads. Rule 36
 * is explicit that a pure read has no move analogue, so there is no ordering probe here and none is
 * being withheld — moving a pure call changes nothing observable. The removal direction is the whole
 * of what these two can be wrong about, and it is the direction that actually regressed before.
 *
 * Usage: node scripts/testing/probes/email-failure-visibility.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const CLASSIFIER = "src/server/email/send-failure.ts";
const NOTICE = "src/lib/email/delivery-notice.ts";

/**
 * The classifier collapsed to a single verdict.
 *
 * This is the pre-Block-B behaviour restored on purpose: every failure reads as retryable, which is
 * what let a permanently rejected sending identity look like something worth trying again.
 */
const collapseClassifier = () =>
  substituteOnce(
    CLASSIFIER,
    "error.statusCode === 403 || FORBIDDEN_PROVIDER_CODES.has(error.name)",
    "error.statusCode === 999999 && FORBIDDEN_PROVIDER_CODES.has(error.name)",
  );

/**
 * The three notices collapsed onto one string.
 *
 * Classification that renders identically to the reader has not made anything visible. The mutation
 * keeps all three classes mapped, so the map is still complete and the lookup still succeeds; only
 * the DISTINGUISHABILITY is removed, which is the property the test claims.
 */
const collapseNotices = () =>
  substituteOnce(
    NOTICE,
    `  forbidden:
    "Tindakan berhasil, tetapi email pemberitahuan tidak terkirim karena identitas pengirim " +
    "ditolak. Laporkan ke tim teknis, mencoba lagi tidak akan membantu.",`,
    `  forbidden: FALLBACK_WARNING,`,
  );

export const probes = [
  {
    name: "a 403 is classified as forbidden, not as something to retry",
    klass: "D",
    harmfulMove:
      "the classifier reporting every provider failure as transient, so a rejected sending " +
      "identity is retried forever and reported as a blip",
    files: [CLASSIFIER],
    appliedMarkers: ["error.statusCode === 999999"],
    mutate: collapseClassifier,
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", "src/server/email/send-failure.test.ts"],
        // Names the case, not just any failure: a renamed file exits non-zero having run nothing.
        /reads a 403 as forbidden|raises a forbidden EmailSendError/,
      ),
  },
  {
    name: "each failure class reaches the reader as different words",
    klass: "D",
    harmfulMove:
      "every class rendering the same sentence, so the operator is told to retry a " +
      "misconfiguration that no retry can clear",
    files: [NOTICE],
    appliedMarkers: ["forbidden: FALLBACK_WARNING"],
    mutate: collapseNotices,
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", "src/lib/email/delivery-notice.test.ts"],
        /renders a distinct message for each failure class|tells the reader NOT to retry/,
      ),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  await runProbes(probes);
}
