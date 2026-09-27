/*
 * Rule 36 probes for the four money-boundary decisions, and for the one pair the step prompt warns
 * is most likely to be collapsed into each other.
 *
 * WHAT ENFORCES EACH, AND WHERE.
 *
 *   DEC-0130 — the platform never custodies funds. `recordFeeAccrualReversal` writes the reversal
 *     as the NEGATION of the accrual it reverses, so an institution's outstanding fee is the SUM of
 *     its rows and no second column has to record which rows are "still open". Class B: a guard
 *     before a write, no transaction of its own, so the harm shows in the POST-STATE the sum reads.
 *
 *   DEC-0131 — a paid registration is not cancellable on candidate initiative. The refuse is in
 *     `cancelRegistration` and again in `cancelTeamRegistration`, both BEFORE their
 *     `db.transaction`. Class A1-pre, which decides the whole experiment: the harmful move is to
 *     move the refuse BELOW `db.transaction`, where it throws the byte-identical error after the
 *     cancellation has committed. Moving it INSIDE the callback is benign — the rollback restores
 *     the post-state — so a probe that moved it there would measure nothing and report success.
 *
 *   DEC-0132 — unpublish is blocked while money is in flight, AND IS NOT DEC-0131. The refuse is
 *     inside `unpublishCompetition`'s transaction, keyed off `hasCompetitionPaymentInFlight` rather
 *     than the narrower confirmed-paid predicate, because the dangerous window is the one where the
 *     transfer has happened and the organiser has not verified it yet. Class A1-in: the detector is
 *     the refusal's IDENTITY, which is also where the two decisions come apart — 0131 refuses the
 *     candidate's own act, 0132 refuses the organiser's, and the escape hatch named in the 0132
 *     message is platform_ops cancellation rather than the candidate withdrawing.
 *
 *   DEC-0133 — the ledger is append-only. There is no database trigger; what holds it is that no
 *     source file under `src/` or `scripts/` can contain a mutation against a finance table, and
 *     `payment-service.append-only.test.ts` is the instrument that says so. Class D — read-only,
 *     the detector reads result content. TWO probes, because one would leave the instrument's
 *     declared subject unmeasured (Rule 38): the first proves the scan actually covers the tree it
 *     claims to, the second proves the pattern added for the upsert form is load-bearing.
 *
 * THE CONTROL RUNS FIRST. Every detector here is a test that PASSES on the committed tree, so a
 * probe goes red when its mutation breaks the guard — but a suite seated over a case that was
 * already failing reports the same red for a reason that has nothing to do with the mutation. Each
 * case is therefore run unmutated before any probe, and refuses the whole run if it does not pass.
 *
 * Usage: npm run verify:dec-conformance
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails, run } from "./detectors.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Absent in CI, where these come from the workflow environment instead.
}

const REGISTRATION_SERVICE = "src/server/registrations/registration-service.ts";
const TEAM_REGISTRATION_SERVICE = "src/server/teams/team-registration-service.ts";
const COMPETITION_SERVICE = "src/server/competitions/competition-service.ts";
const FEE_ACCRUAL_SERVICE = "src/server/finance/fee-accrual-service.ts";
const PAYMENT_EXPIRY_SERVICE = "src/server/finance/payment-expiry-service.ts";
const APPEND_ONLY_TEST = "src/server/finance/payment-service.append-only.test.ts";
const MANUAL_LANE_TEST = "src/server/finance/manual-lane-db.integration.test.ts";

/** A literal for embedding in a `reached` pattern, so a title containing `.` or `(` still matches. */
const regexFree = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A detector that must NAME the case that failed, not merely exit non-zero.
 *
 * `fails` throws rather than returning a verdict when its pattern is absent, so a renamed or
 * mistyped case is a refusal here instead of a probe that reports itself proven on a run that
 * crashed. The `× ` prefix is the reporter's own marker for a case it ran and failed; without it a
 * PASSING case whose name matches would be read as the evidence (Rule 36 clause 3).
 */
const caseFailed = (title) =>
  fails(
    "npx",
    ["vitest", "run", MANUAL_LANE_TEST, "-t", title],
    new RegExp(`× .*${regexFree(title)}`),
  );

/** The scan's own case names, matched on a prefix that carries no `/`, which a regex literal cannot. */
const SCAN_CAUGHT_IT = /× .*contains no update or delete against any finance table/;
const UPSERT_CASE = /× .*still catches a ledger mutation despite the exception list/;

// ── the mutations ───────────────────────────────────────────────────────────────────────────────

/**
 * DEC-0131's refuse, exactly as it stands in `cancelRegistration`.
 *
 * Anchored on the guard as fada388 left it: one condition, no `isPaidCompetition` wrapper.
 *
 * The trailing blank line is part of it, so removing it does not leave the file with two blank
 * lines where the guard was — the mutation has to be the move and nothing else.
 */
const INDIVIDUAL_PAID_REFUSE = [
  "  if (await hasSubmittedPaymentProof(registration.id, db)) {",
  "    throw new RegistrationError(",
  '      "cancellation_not_supported_for_paid",',
  '      "Pendaftaran tidak dapat dibatalkan setelah bukti transfer dikirim",',
  "    );",
  "  }",
  "",
  "",
].join("\n");

const INDIVIDUAL_REFUSE_MOVED = [
  "  // probe: the paid-registration refuse now runs after the cancellation has committed",
  "  if (await hasSubmittedPaymentProof(registration.id, db)) {",
  "    throw new RegistrationError(",
  '      "cancellation_not_supported_for_paid",',
  '      "Pendaftaran tidak dapat dibatalkan setelah bukti transfer dikirim",',
  "    );",
  "  }",
  "",
  "",
].join("\n");

/**
 * DEC-0131's refuse in `cancelTeamRegistration`, the second enforcement site for the same decision.
 *
 * Probed separately rather than assumed from the individual arm: the two arms are separate
 * functions with separate transactions, and the team arm's predicate goes through an ANCHOR lookup
 * first, so a probe over the individual arm says nothing about whether this one still runs before
 * its own commit.
 *
 * Anchored on the guard as fada388 left it: one condition, no `isPaidCompetition` wrapper.
 */
const TEAM_PAID_REFUSE = [
  "  const anchorRegistrationId = await findTeamPaymentGroupAnchor(teamId, db);",
  "",
  "  if (anchorRegistrationId !== null && (await hasSubmittedPaymentProof(anchorRegistrationId, db))) {",
  "    throw new TeamError(",
  '      "cancellation_not_supported_for_paid",',
  '      "Pendaftaran tidak dapat dibatalkan setelah bukti transfer dikirim",',
  "    );",
  "  }",
  "",
  "",
].join("\n");

const TEAM_REFUSE_MOVED = [
  "  // probe: the team paid-registration refuse now runs after the cancellation has committed",
  "  const anchorRegistrationId = await findTeamPaymentGroupAnchor(teamId, db);",
  "",
  "  if (anchorRegistrationId !== null && (await hasSubmittedPaymentProof(anchorRegistrationId, db))) {",
  "    throw new TeamError(",
  '      "cancellation_not_supported_for_paid",',
  '      "Pendaftaran tidak dapat dibatalkan setelah bukti transfer dikirim",',
  "    );",
  "  }",
  "",
  "",
].join("\n");

/** DEC-0132's refuse, inside `unpublishCompetition`'s transaction. */
const IN_FLIGHT_REFUSE = [
  "    if (await hasCompetitionPaymentInFlight(competitionId, tx)) {",
  "      throw new CompetitionError(",
  '        "competition_unpublish_blocked_payment_in_flight",',
  "        409,",
  '        "Kompetisi tidak dapat ditarik selama masih ada bukti transfer yang menunggu verifikasi. Hubungi tim Lombakita untuk pembatalan.",',
  "      );",
  "    }",
  "",
  "",
].join("\n");

const IN_FLIGHT_REFUSE_REMOVED = [
  "    // probe: the payment-in-flight refuse is gone",
  "",
  "",
].join("\n");

/** DEC-0130's negation, with the comment that says why it is a negation rather than a flag. */
const NEGATED_REVERSAL = [
  "        // Negated, so the institution's outstanding fee is the SUM of its rows and never needs a",
  '        // second column recording which rows are "still open".',
  "        amount: -accrued.amount,",
  "",
].join("\n");

const POSITIVE_REVERSAL = ["        amount: accrued.amount,", ""].join("\n");

/**
 * DEC-0133's upsert pattern, the form `INSERT … ON CONFLICT … DO UPDATE` takes.
 *
 * The word `update` in this statement is followed by `SET`, never by a table name, so none of the
 * other patterns can see it — which is the property the second probe measures.
 */
const UPSERT_PATTERN = [
  "  new RegExp(",
  "    String.raw`\\binsert\\s+into\\s+${RAW_TABLE}[^;]*?\\bon\\s+conflict\\b[^;]*?\\bdo\\s+update`,",
  '    "gi",',
  "  ),",
  "",
].join("\n");

const UPSERT_PATTERN_REMOVED = ["  // probe: the upsert pattern is gone", ""].join("\n");

/**
 * A ledger mutation written into a real finance source, which is the shape the scan exists to catch.
 *
 * READ FROM A FIXTURE RATHER THAN WRITTEN HERE, and that is the finding rather than a tidiness
 * choice. The scan walks every `.ts|.tsx|.mjs|.js` under `scripts/`, so this probe suite holding the
 * statement as a string literal is a file the scan reported as containing a ledger mutation — and
 * the scan was right about the text and wrong about the file. A `.txt` sits outside the scan's
 * declared subject for the same reason it sits outside its risk: nothing executes it. Naming it as
 * data is cheaper than exempting a file, and it leaves the scan's guarantee exactly as strong.
 *
 * `await` on a drizzle `sql` tag is legal and type-checks, so the injected file still compiles and
 * the probe's red is the scan's verdict rather than a type error. The statement never runs: the
 * detector is a source scan, not an execution.
 */
const LEDGER_UPDATE_FIXTURE = new URL("./fixtures/ledger-update.txt", import.meta.url);

/** The statement itself, unindented, as the fixture holds it. */
const ledgerUpdateStatement = () => readFileSync(LEDGER_UPDATE_FIXTURE, "utf8").trim();

/**
 * The mutation's own comment, and the marker clause 2 asserts on.
 *
 * Deliberately names no table: a marker carrying the statement's text would be a second copy of
 * that text inside this file, which is the thing the fixture exists to avoid.
 */
const LEDGER_UPDATE_MARKER =
  "    // probe: a ledger row is rewritten in place, for the scan to find";

// ── the control ─────────────────────────────────────────────────────────────────────────────────

/**
 * Every case the probes below turn red, run unmutated first.
 *
 * A probe whose case was already failing goes red for a reason that has nothing to do with its
 * mutation, and reads identically to one that measured. This is the run that says it was passing.
 */
const CONTROL_CASES = [
  ["DEC-0131", "REFUSES an individual cancellation and leaves the registration confirmed"],
  [
    "DEC-0131 (team arm)",
    "REFUSES a team cancellation and leaves every member's registration confirmed",
  ],
  ["DEC-0132", "takes the competition down, not just its registrations"],
  ["DEC-0130", "sums an accrual and its reversal to zero outstanding"],
];

const proveTheCommittedEnforcementHolds = () => {
  for (const [decision, title] of CONTROL_CASES) {
    const result = run("npx", ["vitest", "run", MANUAL_LANE_TEST, "-t", title]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    if (result.status !== 0) {
      throw new Error(
        `${decision}'s case "${title}" does not pass on the committed tree, so its probe would go ` +
          `red over a case that was already red. Its output:\n${output.slice(-800)}`,
      );
    }

    console.log(
      `control  ${decision}  ${title}\n         PASSES unmutated — the probe below turns it red`,
    );
  }

  const scan = run("npx", ["vitest", "run", APPEND_ONLY_TEST]);
  const scanOutput = `${scan.stdout ?? ""}${scan.stderr ?? ""}`;

  if (scan.status !== 0) {
    throw new Error(
      `DEC-0133's scan does not pass on the committed tree, so neither of its probes can say ` +
        `anything:\n${scanOutput.slice(-800)}`,
    );
  }

  console.log(
    "control  DEC-0133  the append-only scan over src/ and scripts/\n" +
      "         PASSES unmutated — no source file mutates a finance row, and the scan's own\n" +
      "         synthetic sources for every spelling it claims to catch are found",
  );
};

// ── the probes ──────────────────────────────────────────────────────────────────────────────────

export const probes = [
  {
    name: "a candidate cancels a paid registration out from under a submitted bukti transfer — INDIVIDUAL REFUSE MOVED BELOW THE TRANSACTION",
    klass: "A1-pre",
    harmfulMove:
      "moving the paid-registration refuse below `db.transaction`, where it throws the identical " +
      "error after the cancellation has committed — the refusal still reads correctly to the " +
      "caller, and the candidate's money is already with an organiser who has been told nothing",
    files: [REGISTRATION_SERVICE],
    appliedMarkers: [
      "// probe: the paid-registration refuse now runs after the cancellation has committed",
    ],
    mutate: () => {
      substituteOnce(REGISTRATION_SERVICE, INDIVIDUAL_PAID_REFUSE, "");
      substituteOnce(
        REGISTRATION_SERVICE,
        "  if (!updated) {\n",
        INDIVIDUAL_REFUSE_MOVED + "  if (!updated) {\n",
      );
    },
    detect: async () =>
      caseFailed("REFUSES an individual cancellation and leaves the registration confirmed"),
  },
  {
    name: "a captain cancels a paid team registration out from under a submitted bukti transfer — TEAM REFUSE MOVED BELOW THE TRANSACTION",
    klass: "A1-pre",
    harmfulMove:
      "the same move against the team arm, which is a separate function with its own transaction and " +
      "its own anchor lookup — so the individual arm holding says nothing about whether this one " +
      "still runs before its commit",
    files: [TEAM_REGISTRATION_SERVICE],
    appliedMarkers: [
      "// probe: the team paid-registration refuse now runs after the cancellation has committed",
    ],
    mutate: () => {
      substituteOnce(TEAM_REGISTRATION_SERVICE, TEAM_PAID_REFUSE, "");
      substituteOnce(
        TEAM_REGISTRATION_SERVICE,
        "  for (const reg of cancelResult.registrations) {\n",
        TEAM_REFUSE_MOVED + "  for (const reg of cancelResult.registrations) {\n",
      );
    },
    detect: async () =>
      caseFailed("REFUSES a team cancellation and leaves every member's registration confirmed"),
  },
  {
    name: "an organiser unpublishes a competition while a bukti transfer awaits verification — IN-FLIGHT REFUSE REMOVED",
    klass: "A1-in",
    harmfulMove:
      "removing the payment-in-flight refuse, so unpublish proceeds to cancel every registration on " +
      "the competition — including one whose payer has already transferred real rupiah to the " +
      "organiser's account and whose proof nobody has verified yet",
    files: [COMPETITION_SERVICE],
    appliedMarkers: ["// probe: the payment-in-flight refuse is gone"],
    mutate: () => substituteOnce(COMPETITION_SERVICE, IN_FLIGHT_REFUSE, IN_FLIGHT_REFUSE_REMOVED),
    detect: async () => caseFailed("takes the competition down, not just its registrations"),
  },
  {
    name: "a reversal is recorded as a second accrual, so the institution's outstanding fee doubles — NEGATION REMOVED",
    // NOT a guard, and saying so is the honest classification (Rule 38). `recordFeeAccrualReversal`'s
    // negation has no control flow, no write to order against, and nothing to remove or relocate —
    // the mutation flips a SIGN, not a guard's position. Class B asserts "a guard before a write,
    // no transaction", an ordering relationship this code does not have. The property is
    // value correctness, measured by the post-state sum.
    klass: "value",
    harmfulMove:
      "recording a reversal as a positive accrual, so a debt the platform had already written off " +
      "reads as twice what it was — the append-only shape is intact and every row is still a row, " +
      "which is why nothing but the sum can see it",
    files: [FEE_ACCRUAL_SERVICE],
    appliedMarkers: ["amount: accrued.amount,"],
    mutate: () => substituteOnce(FEE_ACCRUAL_SERVICE, NEGATED_REVERSAL, POSITIVE_REVERSAL),
    detect: async () => caseFailed("sums an accrual and its reversal to zero outstanding"),
  },
  {
    name: "a ledger UPDATE is written into a finance source and the append-only scan reports the tree clean",
    klass: "D",
    harmfulMove:
      "an UPDATE against `finance_payments` written into a real finance source — the shape a " +
      '"just fix this one row" change takes — so a recorded money fact moves and no row records that it did',
    files: [PAYMENT_EXPIRY_SERVICE],
    appliedMarkers: [LEDGER_UPDATE_MARKER],
    mutate: () =>
      substituteOnce(
        PAYMENT_EXPIRY_SERVICE,
        "    if (!payment?.registrationId) return null;\n",
        `${LEDGER_UPDATE_MARKER}\n    ${ledgerUpdateStatement()}\n\n` +
          "    if (!payment?.registrationId) return null;\n",
      ),
    detect: async () => fails("npx", ["vitest", "run", APPEND_ONLY_TEST], SCAN_CAUGHT_IT),
  },
  {
    name: "an upsert against the ledger reads as clean because the pattern that sees it was deleted",
    klass: "D",
    harmfulMove:
      "deleting the `insert … on conflict … do update` pattern from the scan, so the one form that " +
      "rewrites an existing ledger row without ever naming a table after `update` is once again " +
      "invisible to every pattern that remains",
    files: [APPEND_ONLY_TEST],
    appliedMarkers: ["// probe: the upsert pattern is gone"],
    mutate: () => substituteOnce(APPEND_ONLY_TEST, UPSERT_PATTERN, UPSERT_PATTERN_REMOVED),
    detect: async () => fails("npx", ["vitest", "run", APPEND_ONLY_TEST], UPSERT_CASE),
  },
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  proveTheCommittedEnforcementHolds();
  await runProbes(probes);
}
