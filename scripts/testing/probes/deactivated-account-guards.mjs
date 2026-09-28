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
 * THE CLASS OF EACH GUARD IS DECLARED RATHER THAN ASSUMED (clause 8). The two moderation guards are
 * A1-in: both throw INSIDE the transaction that would perform the write, so the rollback is what
 * restores the post-state and the detector is the refusal identity — the code and status the caller
 * receives. The session guard is D: nothing is written and nothing is rolled back, and what the
 * mutation changes is the CONTENT of the value the lookup produces, which is exactly what the
 * detector reads.
 *
 * WHAT IS NOT PROBED, AND WHY. The owner-count lock — the concurrency guard that would stop two
 * co-owners of one institution de-identifying concurrently — is not probed because it does not
 * exist. The ownership code takes no advisory lock keyed on an institution when an owner membership
 * changes; the four advisory locks in this repository are keyed on a registration, a competition, an
 * institution-verification submission and a user's owned-institution count. There is no lock to
 * remove, so there is no probe to write, and a probe reporting otherwise would be reporting a
 * property the code does not have. It is recorded here rather than fabricated into a green.
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

export const probes = [
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
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("deactivated-account-guards", [
    ["npx", ["vitest", "run", AUTH_TEST]],
    ["npx", ["vitest", "run", MODERATION_TEST]],
  ]);
  await runProbes(probes);
}
