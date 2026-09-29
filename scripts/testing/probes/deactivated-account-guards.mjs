/*
 * Rule 36 probes for `deactivated` meaning gone.
 *
 * A de-identified account is a TOMBSTONE. The person's rows are removed, their files are deleted, and
 * the row that survives carries no name, address or username — so every surface that still holds a
 * reference to it is pointing at a subject that no longer answers. Three of those surfaces are here,
 * and each one is a place the tombstone could be treated as a live account:
 *
 *   the session      a de-identified account's existing cookie keeps authenticating, because the row
 *                    survives and its `suspended_at` is NULL — so nothing on the suspension path
 *                    fires and only `status` can end the session;
 *   unsuspending    an operator lifts a suspension on an account whose data is gone, writing to a
 *                    row the person is no longer reachable through;
 *   reinstating     an institution whose last owner was de-identified is restored to operations,
 *                    with nobody left who can perform any of them.
 *
 * THE CLASS OF EACH GUARD IS DECLARED RATHER THAN ASSUMED (clause 8). Three are A1-in: the guard
 * itself and the two moderation refusals it sits beside all throw INSIDE the transaction that would
 * perform the write, so the rollback is what restores the post-state and the detector is the refusal
 * identity — the code and status the caller receives. The session guard is D: nothing is written and
 * nothing is rolled back, and what the mutation changes is the CONTENT of the value the lookup
 * produces, which is exactly what the detector reads. The owner-membership lock probe is B: the lock
 * stands in front of a read inside the same transaction, and what the race suite reads is the parked
 * backend's own statement and the state the institution is left in.
 *
 * THE ROW LOCK IS PROBED HERE RATHER THAN WITH THE RACE IT PROTECTS. The guard's read takes the row
 * it reads, which is what makes an operator write queue behind a de-identification instead of
 * answering from a version about to change. Its harm is only visible with two backends, so its
 * detector is the race suite's — parked on the de-identification's row lock or refused — and the
 * probe is filed here because the line it mutates is this file's.
 *
 * THE OWNER-COUNT LOCK IS PROBED FROM HERE. The lock that stops two co-owners of one institution
 * changing its ownership concurrently now exists —
 * `@/server/institution-members/owner-membership-lock`, keyed `inst_owner_membership:{institutionId}`
 * — and this file carries the half of it that lives in `member-service.ts`. The de-identification's
 * own call to it is probed in `deidentification-guards.mjs`; both probes name the same race suite,
 * because the harm is the one state and either call alone can fail to prevent it.
 *
 * The deactivated guard itself is applied to every operator write that names a target user, and only
 * the `unsuspendUser` call site is probed: the guard is ONE function called from many places, so a
 * second probe would remove the same call and measure the same refusal. The call sites and the
 * writes judged out of scope are listed in the step report rather than re-cut here.
 *
 * Usage: node scripts/testing/probes/deactivated-account-guards.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const AUTH_CONFIG = "src/server/auth/auth.config.ts";
const AUTH_TEST = "src/server/auth/auth-config-suspension.test.ts";
const MODERATION_SERVICE = "src/server/moderation/moderation-service.ts";
const MODERATION_TEST = "src/server/moderation/moderation-service.test.ts";
const MEMBER_SERVICE = "src/server/institution-members/member-service.ts";
const DEACTIVATED_ACCOUNT = "src/server/accounts/deactivated-account.ts";
const RACE_TEST = "src/server/accounts/account-deidentification-race-db.integration.test.ts";

export const probes = [
  {
    name: "the de-identified-account guard takes the row it reads with `for update`",
    klass: "A1-in",
    harmfulMove:
      "the guard's read not taking the row. A plain read under READ COMMITTED answers with the last " +
      "committed version, so an operator write racing a de-identification reads the target as live " +
      "— the flip is not committed yet — passes the guard, and then writes its own change onto the " +
      "tombstone once the de-identification lands. The account's data is gone and an operator has " +
      "just acted on it, audited as an ordinary action on a live account",
    files: [DEACTIVATED_ACCOUNT],
    // The lock's EFFECT removed rather than its clause rewritten: the `for update` suffix is dropped
    // and the statement stays a statement, so the mutation compiles for a reason rather than by luck
    // (clause 1). The marker is the statement against the refusal that follows it, which the
    // unmutated file does not hold — there the two are separated by the `.for("update")` line.
    appliedMarkers: ['    .limit(1);\n\n  if (row?.status === "deactivated") {'],
    mutate: () =>
      substituteOnce(
        DEACTIVATED_ACCOUNT,
        '    .limit(1)\n    .for("update");',
        "    .limit(1);",
      ),
    // Class A1-in: the guard throws inside the transaction the write would commit in, so the rollback
    // is what leaves the row untouched. The detector is the refusal identity — the code the caller
    // receives — and the race suite is the only place the interleaving exists: it holds the target's
    // row in a second backend, lets the de-identification queue behind it, and only then submits the
    // unsuspend. With the lock gone the unsuspend is not refused at all, which is the assertion that
    // goes red first; the run's own end state, asserted after it, is red for the same reason.
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", RACE_TEST],
        /× .*refuses an operator's unsuspend that arrives while the account is being de-identified/,
      ),
  },
  {
    name: "a de-identified account's sessions end where its status is read",
    klass: "D",
    harmfulMove:
      "the status column read but not acted on, so a de-identified account is indistinguishable from a " +
      "live one at the only place its sessions are decided: `suspended_at` is NULL on the tombstone, " +
      "so the suspension gate never fires, the role is surfaced from the live row, and the cookie the " +
      "person already holds keeps authenticating against an account whose data has been deleted",
    files: [AUTH_CONFIG],
    // The removal takes the comment WITH the clause it describes, so no line is left in the file
    // claiming something the code no longer does. That empties the gap between the not-found refusal
    // and the found return, which is the adjacency the marker names — it exists only after the
    // mutation, because the unmutated file has the comment and the clause in that gap.
    appliedMarkers: ['    if (!row) {\n      return { status: "missing" };\n    }\n\n    return {'],
    mutate: () =>
      substituteOnce(
        AUTH_CONFIG,
        [
          "    // `deactivated` is the de-identification action's tombstone. The row survives it, so this is",
          "    // what ends the account's sessions rather than a deleted row would have.",
          '    if (row.status === "deactivated") {',
          '      return { status: "missing" };',
          "    }",
          "",
          // The blank line that separated the clause from the return. Taking it with the clause is
          // what makes the removal the two-line gap the marker names rather than a gap with an extra
          // empty line in it.
          "",
        ].join("\n"),
        "",
      ),
    // Class D rather than A1-in: no transaction is entered and nothing is written, so there is no
    // post-state to read. What changes is the value the callback surfaces — the role it hands the
    // access layer — and the detector reads that value and the refusal it produces. The refusal is
    // reached through `assertAuthenticatedSession`, the gate every guarded request already passes,
    // rather than through an export of the lookup (Rule 33).
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", AUTH_TEST],
        /× .*surfaces no role for a de-identified account whose suspended_at is null/,
      ),
  },
  {
    name: "an operator cannot unsuspend an account whose data has been deleted",
    klass: "A1-in",
    harmfulMove:
      "an operator lifting the suspension on a de-identified account. The tombstone carries " +
      "`suspended_at` NULL, so the not-suspended refusal above does not stop it and the write lands on " +
      "a row the person is no longer reachable through — audited as an ordinary reinstatement of an " +
      "account that no longer has any data to reinstate",
    files: [MODERATION_SERVICE],
    // The guard call removed from the writing transaction and nothing else, so the update and the
    // audit insert that follow it stay in place and the mutation is the guard's absence rather than a
    // rewritten transaction. The marker is that update's own four lines against the transaction
    // opening: the unmutated file holds the guard between them.
    appliedMarkers: [
      "  await db.transaction(async (tx) => {\n" +
        "    await tx\n" +
        "      .update(users)\n" +
        "      .set({ suspendedAt: null, suspensionReason: null, updatedAt: now })",
    ],
    mutate: () =>
      substituteOnce(
        MODERATION_SERVICE,
        [
          "  await db.transaction(async (tx) => {",
          "    await assertAccountNotDeactivated(tx, targetUserId, ModerationError);",
          "",
          "    await tx",
          "      .update(users)",
          "      .set({ suspendedAt: null, suspensionReason: null, updatedAt: now })",
        ].join("\n"),
        [
          "  await db.transaction(async (tx) => {",
          "    await tx",
          "      .update(users)",
          "      .set({ suspendedAt: null, suspensionReason: null, updatedAt: now })",
        ].join("\n"),
      ),
    // Class A1-in: the guard throws inside the transaction, so the rollback is what leaves the row
    // untouched. The detector is therefore the refusal identity — the code and status the caller
    // receives — and the same test also asserts that neither the update nor the audit insert ran.
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", MODERATION_TEST],
        /× .*refuses a de-identified target with 409 account_deactivated/,
      ),
  },
  {
    name: "an institution with no active owner is not reinstated",
    klass: "A1-in",
    harmfulMove:
      "reinstating an institution whose last owner was de-identified — every owner membership of the " +
      "target is revoked by that action, so the institution is left suspended with nobody who can " +
      "publish, invite or change anything in it. Restoring operations restores them for no one, and " +
      "the audit row reports a functioning institution",
    files: [MODERATION_SERVICE],
    // The comment, the count and the refusal removed together, leaving the transaction opening
    // directly against the update it guards. The marker includes the update's own set-values line
    // rather than stopping at `.update(institutions)`, because `suspendInstitution` opens its
    // transaction the same way and a shorter marker would already be present before the mutation.
    appliedMarkers: [
      "  await db.transaction(async (tx) => {\n" +
        "    await tx\n" +
        "      .update(institutions)\n" +
        "      .set({ suspendedAt: null, suspensionReason: null, updatedAt: now })",
    ],
    mutate: () =>
      substituteOnce(
        MODERATION_SERVICE,
        [
          "    // Reinstating an institution nobody owns restores operations no one can perform. Every owner",
          "    // membership of a de-identified account is revoked, so this is the state the de-identification",
          "    // action leaves a shared institution in when the last owner was the target.",
          "    if ((await countActiveOwners(tx, targetInstitutionId)) === 0) {",
          "      throw new ModerationError(",
          '        "institution_has_no_owner",',
          "        409,",
          '        "Institusi ini tidak memiliki pemilik aktif, sehingga tidak dapat dipulihkan.",',
          "      );",
          "    }",
          "",
          // The blank line after the refusal, so the removal leaves the transaction opening directly
          // against the update rather than with an empty line between them.
          "",
        ].join("\n"),
        "",
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", MODERATION_TEST],
        /× .*refuses with 409 institution_has_no_owner when no active owner remains/,
      ),
  },
  {
    name: "a demotion takes the institution's owner-membership lock before it counts owners",
    klass: "B",
    harmfulMove:
      "a demotion of one co-owner running against a de-identification of the other. Both refuse on a " +
      "count of the institution's active owner rows and both change a DIFFERENT one of those rows, so " +
      "with nothing keyed on the institution each counts the other's still-active membership, both " +
      "pass, and the institution is left with no owner — the state the reinstatement refusal above " +
      "exists to detect, reached by the two operations that should have prevented it",
    files: [MEMBER_SERVICE],
    // The lock call and its comment removed together, so the transaction opens directly against the
    // target read. The marker is that adjacency, and it exists only after the mutation: the
    // unmutated file holds the lock comment and the call in the gap. `recruiterVerifiedAt` is what
    // makes the marker this function's rather than `removeMember`'s, which opens identically.
    appliedMarkers: ["  await db.transaction(async (tx) => {\n    const [target] = await tx"],
    mutate: () =>
      substituteOnce(
        MEMBER_SERVICE,
        [
          "  await db.transaction(async (tx) => {",
          "    // Taken before the target read so the whole transaction, including the owner count below, sees",
          "    // one consistent set of memberships: a demotion and a concurrent de-identification of a",
          "    // co-owner each count the other's row, and counting a row the other transaction is about to",
          "    // change is how an institution ends up with no owner at all.",
          "    await lockInstitutionOwnership(tx, [institutionId]);",
          "",
          "    const [target] = await tx",
        ].join("\n"),
        ["  await db.transaction(async (tx) => {", "    const [target] = await tx"].join("\n"),
      ),
    // Class B: the lock stands in front of the count inside the same transaction, so the read is the
    // post-state the two operations leave. The race suite reads the parked backend's own statement
    // from `pg_stat_activity`, which is what tells a racer queued AT this lock from one that ran past
    // it, and then the owner count the institution is left with.
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", RACE_TEST],
        /never parked on the institution's owner-membership lock/,
      ),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("deactivated-account-guards", [
    ["npx", ["vitest", "run", AUTH_TEST]],
    ["npx", ["vitest", "run", MODERATION_TEST]],
    ["npx", ["vitest", "run", RACE_TEST]],
  ]);
  await runProbes(probes);
}
