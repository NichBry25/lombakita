/*
 * Rule 36 probes for the account de-identification action.
 *
 * WHAT THIS ACTION IS THE ONLY THING STANDING IN FRONT OF. `deidentifyAccount` is the platform's one
 * in-app path for removing a person on their own request, and it is irreversible by construction: the
 * files go, the personal rows go, and the rows other people depend on are kept with the personal
 * values stripped out. There is no second attempt after it has run, because there is nothing left to
 * run it against.
 *
 * EVERY MUTATION HERE LANDS IN `account-deidentification-service.ts`, and the detectors are the two
 * suites that already cover it — the unit test for the prefix list, the integration suite for the
 * refusals and the full run, the committing race suite for the row lock. Nothing in this file is a
 * new test written for the probe's benefit; a probe whose detector exists only to be broken by it
 * measures the probe.
 *
 * THE CLASS OF EACH GUARD IS DECLARED RATHER THAN ASSUMED (clause 8). Seven of the eleven are B: a
 * refusal, a lock, or a source-of-truth choice that stands in front of a write — the three SCOPE
 * choices among them (which rows a target's upload is, which objects a surviving ledger row keeps,
 * and which registrations' document-request files go) are B for the same reason and are read the
 * same way, through the post-state the run leaves. Three are A1-in: the rehearsal sentinel, the
 * operator-role refusal and the forming-team-captain refusal all throw INSIDE a transaction, so their
 * detectors are the refusal identity — the run that follows a committed rehearsal refuses instead of
 * de-identifying, and the refused role and the refused captaincy are each named by the code the
 * caller receives. The one class D probe is the prefix list's CONTENT — which prefixes a target
 * produces — where the source-of-truth probe is the ordering claim around the same builder: not what
 * it returns, but which read's answer it was given.
 *
 * ONE DETECTOR IS A PROPERTY OF THE SOURCE RATHER THAN A RUN, AND SAYS SO. The owner-membership
 * lock's probe cannot make its guard's harm happen on demand: the harm is a deadlock between two
 * writers, which needs an interleaving no test can schedule, and restoring the old order leaves the
 * race suite green because both racers still queue at a lock — just a different one. That probe's
 * detector is therefore the source-order assertion in the unit suite, which reads the position of the
 * two calls in the service. The alternative was a fabricated green, and the failure it would have
 * hidden is the one this file exists to catch.
 *
 * WHAT IS NOT PROBED, AND WHY. The compare-and-set (`where id = U and status <> 'deactivated'`) is
 * not separately probed. Every interleaving that reaches it has already been refused by the
 * deactivated clause re-run inside the writing transaction — that clause throws first, from the same
 * locked row — so removing the CAS predicate turns no assertion red, and a probe reporting otherwise
 * would be reporting a property the code does not have. It is recorded here rather than fabricated
 * into a green.
 *
 * RETIRED BY CONTROLLER RULING: the probe that targeted the pre-read's files-remaining clause. That
 * clause is gone from the service, deleted because it contradicted the writing transaction's own
 * re-check: an account reading deactivated with objects still under its prefixes is reachable only by
 * an upload racing the operation — every failure before the commit leaves the account NOT
 * deactivated, where a rerun already completes the work — and such an account is refused 409
 * `deidentify_already_done` on its status alone, by design. The probe could not have been red for the
 * move it claimed: the writing transaction refuses the same target from the same locked row, so
 * inverting the pre-read changed no observable at all. Its red before the clause was deleted came
 * from the rehearsal relabelling a refusal to 500, which is a different defect and a fixed one. It is
 * recorded here rather than re-cut into a green.
 *
 * Usage: node scripts/testing/probes/deidentification-guards.mjs
 * Runs only over committed work — the harness refuses if any listed file differs from HEAD.
 */
import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const SERVICE = "src/server/accounts/account-deidentification-service.ts";
const UNIT_TEST = "src/server/accounts/account-deidentification-service.test.ts";
const INTEGRATION_TEST = "src/server/accounts/account-deidentification-db.integration.test.ts";
const RACE_TEST = "src/server/accounts/account-deidentification-race-db.integration.test.ts";

export const probes = [
  {
    name: "the writing transaction locks the target's row before the checks it protects",
    klass: "B",
    harmfulMove:
      "two de-identifications of the same account running their reads and writes interleaved because " +
      "the writing transaction never takes the row, so a second operator's run is told the account is " +
      "eligible on the strength of a read that the first run invalidates before the second one writes",
    files: [SERVICE],
    // The lock's EFFECT removed rather than its clause rewritten: the `for update` suffix is dropped
    // and the statement stays a statement, so the mutation compiles for a reason rather than by luck
    // (clause 1). The marker carries the next statement, because the statement WITHOUT the suffix is a
    // prefix of the statement with it and would be present before the mutation as well — and it is
    // the re-read below rather than a comment, so the marker still names code after the comment above
    // this statement was rewritten.
    appliedMarkers: [
      "  await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId));\n\n  const currentInstitutionIds = await findInstitutionsWhereTargetIsActiveMember(tx, accountId);",
    ],
    mutate: () =>
      substituteOnce(
        SERVICE,
        '  await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId)).for("update");',
        "  await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId));",
      ),
    // THE DETECTOR HAD TO BE BUILT BEFORE THIS PROBE COULD BE HONEST. The race suite already polled
    // `pg_blocking_pids` for both racers, and that poll stays green with the lock removed — the
    // compare-and-set writes the same row a few statements later, so the racers simply queue there
    // instead. That was measured, not reasoned about. The assertion this detector names reads the
    // parked backend's own statement from `pg_stat_activity`, which is what tells a racer queued at
    // the lock from one queued at the write the lock exists to precede.
    //
    // IT IS THE FIRST ASSERTION OF THE TWO, so it is the one whose message the run prints. With the
    // lock gone the racer that holds the institution's owner-membership lock runs past the read and
    // parks at the compare-and-set, which is neither lock this line accepts.
    detect: async () =>
      fails("npx", ["vitest", "run", RACE_TEST], /rather than on a lock: the writing transaction has/),
  },
  {
    name: "the deletion set never reaches the payment-proofs prefix",
    klass: "D",
    harmfulMove:
      "the prefix list widened to the ledger's own evidence, so a de-identification would delete the " +
      "image behind a row DEC-0133 forbids removing and leave an append-only row pointing at nothing " +
      "— a harm the action cannot undo, since the object is gone and the row stays",
    files: [SERVICE],
    // The prefix is pushed as a literal rather than through `fillUserPrefix`, because the real
    // template has no `{userId}` placeholder and the substitution helper would throw on it — a red
    // for a reason this probe did not claim (clause 1).
    appliedMarkers: ["  prefixes.push(`payment-proofs/${target.userId}/`);"],
    mutate: () =>
      substituteOnce(
        SERVICE,
        "  if (target.personalInstitutionId !== null) {",
        "  prefixes.push(`payment-proofs/${target.userId}/`);\n\n  if (target.personalInstitutionId !== null) {",
      ),
    detect: async () =>
      fails("npx", ["vitest", "run", UNIT_TEST], /× .*never lists payment-proofs, on any target/),
  },
  {
    name: "the typed confirmation is compared exactly, casing included",
    klass: "B",
    harmfulMove:
      "a near-match accepted as the confirmation, so an operator who typed a different account's " +
      "username — or the right name with a stray capital — de-identifies a person they never named",
    files: [SERVICE],
    appliedMarkers: [
      "  if (input.confirmUsername.trim().toLowerCase() !== target.username.trim().toLowerCase()) {",
    ],
    // Normalised rather than deleted, and deliberately: an empty comparison would be a shape no
    // reviewer would write, while trimming and lowercasing is exactly the correction someone makes
    // when a confirmation "keeps failing". Every type and every reference stays in place.
    mutate: () =>
      substituteOnce(
        SERVICE,
        "  if (input.confirmUsername !== target.username) {",
        "  if (input.confirmUsername.trim().toLowerCase() !== target.username.trim().toLowerCase()) {",
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", INTEGRATION_TEST],
        /× .*refuses 400 when the typed confirmation differs, casing included/,
      ),
  },
  {
    name: "the rehearsal rolls back rather than committing what it rehearsed",
    klass: "A1-in",
    harmfulMove:
      "the rehearsal committing its own writes: the pre-flight pass that exists to prove the writes " +
      "would succeed would itself de-identify the account, and the real run that follows it would " +
      "find the account already deactivated and refuse — an operator told the action failed, holding " +
      "an account that is gone",
    files: [SERVICE],
    // The throw replaced by a use of the same variable, so `written` stays read, `rollbackThrown`
    // stays assigned, and the transaction returns normally — the commit this guard exists to prevent,
    // reached with every reference intact. Removing `rollbackThrown = true` instead would leave the
    // tripwire below it to throw, which is a red for a reason this probe did not claim (clause 1).
    appliedMarkers: ["        void written;"],
    mutate: () =>
      substituteOnce(
        SERVICE,
        "        throw new RehearsalRollback(written);",
        "        void written;",
      ),
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", INTEGRATION_TEST],
        /× .*removes, scrubs and accounts for everything the fixture planted/,
      ),
  },
  {
    name: "the files stage lists the prefixes the rehearsal resolved, not the pre-read's",
    klass: "B",
    harmfulMove:
      "the R2 prefix list built from the pre-read's facts, a stage earlier than the writes, so a " +
      "registration created in the gap is scrubbed by the commit while the objects under its two " +
      "prefixes are never listed and never deleted — the person's file stays in the bucket with no " +
      "row left naming it, which is the residue the commit's own re-read cannot repair",
    files: [SERVICE],
    // The pre-read's result bound, returned and handed to the prefix builder, so the source of the
    // list is the stage the harm is about. The `rehearsal` binding is left in place and still read:
    // it now carries two values the builder does not take (the submission keys and the retained
    // keys), so discarding the rehearsal as well would leave it assigned and never read — a mutation
    // nobody would write — and the helper's signature has no shape that drops them.
    appliedMarkers: [
      "  const facts = await db.transaction(async (tx) => {\n    assertReasonPresent(input);",
      "    return assertTargetIsEligible(tx, accountId, input);\n  });\n\n  let rehearsal: WriteOutcome;",
      "    registrations: facts.registrations,\n    personalInstitutionId: facts.personalInstitutionId,",
    ],
    mutate: () => {
      substituteOnce(
        SERVICE,
        "  await db.transaction(async (tx) => {\n    assertReasonPresent(input);",
        "  const facts = await db.transaction(async (tx) => {\n    assertReasonPresent(input);",
      );
      substituteOnce(
        SERVICE,
        "    await assertTargetIsEligible(tx, accountId, input);\n  });\n\n  let rehearsal: WriteOutcome;",
        "    return assertTargetIsEligible(tx, accountId, input);\n  });\n\n  let rehearsal: WriteOutcome;",
      );
      substituteOnce(
        SERVICE,
        "    registrations: rehearsal.registrations,\n    personalInstitutionId: rehearsal.personalInstitutionId,",
        "    registrations: facts.registrations,\n    personalInstitutionId: facts.personalInstitutionId,",
      );
    },
    // The detector is post-state, which is this guard's class: the suite reads the mocked bucket, so
    // what it observes is the object the deletion failed to remove, not a status code.
    detect: async () =>
      fails("npx", ["vitest", "run", INTEGRATION_TEST], /× .*comes from the rehearsal's read/),
  },
  {
    name: "the writing transaction takes the institution's owner-membership lock before the target's row",
    klass: "B",
    harmfulMove:
      "the two locks taken in the other order: institutions first is what two writers overlapping on " +
      "institution sets agree on, and a writer that takes the target's row first can hold it while it " +
      "waits for an institution another writer holds while it waits for this row — the deadlock the " +
      "ordering exists to prevent, which Postgres breaks by aborting one of the two mid-run",
    files: [SERVICE],
    // THE MOVE ITSELF, not a removal: both calls stay, both keep doing their job, and the only thing
    // the mutation changes is which of them comes first. The row lock is lifted out of its own place
    // and set down above the institution lock, so the marker is the adjacency that only the mutated
    // file holds — the row lock directly above the institution lock.
    appliedMarkers: [
      '  await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId)).for("update");\n\n  await lockInstitutionOwnership(tx, lockedInstitutionIds);',
    ],
    mutate: () => {
      substituteOnce(
        SERVICE,
        '  await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId)).for("update");\n\n',
        "",
      );
      substituteOnce(
        SERVICE,
        "  await lockInstitutionOwnership(tx, lockedInstitutionIds);",
        '  await tx.select({ id: users.id }).from(users).where(eq(users.id, accountId)).for("update");\n\n  await lockInstitutionOwnership(tx, lockedInstitutionIds);',
      );
    },
    // THE DETECTOR IS THE SOURCE ORDER, AND THE RACE SUITE CANNOT BE IT.
    //
    // The harm needs an interleaving the race suite cannot schedule: restoring this order leaves both
    // racers queued at a lock — one at the row, the other behind it — so every assertion the suite
    // makes about parked backends and about the owner count the institution is left with still holds.
    // Measured on this tree rather than reasoned about: the race suite passes with the order reversed.
    // What the move changes, exactly, is the POSITION of one call, so the position is what is
    // asserted — by the unit suite, which reads the service's source with its comments stripped and
    // compares the index of each call. Both ends are asserted above the comparison there, so a rename
    // that left one identifier absent fails as the right order rather than as a passing -1.
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", UNIT_TEST],
        /× .*takes the institution's owner-membership lock before the target's row/,
      ),
  },
  {
    name: "a team registration's document-request files go when the target captains it",
    klass: "B",
    harmfulMove:
      "the document-request files scoped to the registrations the target holds ALONE. A team " +
      "registration the target captains is left out of both reaches — no prefix is listed for it and " +
      "no row of it is deleted — so its files outlive the account they belong to, kept by a scope " +
      "narrower than the authorization it stands for",
    files: [SERVICE],
    // The scope reverted to the solo set, which is the shape this guard replaced. The marker is the
    // reverted clause against the subquery it narrows, an adjacency the unmutated file does not hold.
    appliedMarkers: [
      "                .where(inArray(competitionDocumentRequests.registrationId, soloRegistrationIds)),",
    ],
    mutate: () =>
      substituteOnce(
        SERVICE,
        [
          "          .delete(competitionDocumentRequestFiles)",
          "          .where(",
          "            inArray(",
          "              competitionDocumentRequestFiles.requestId,",
          "              tx",
          "                .select({ id: competitionDocumentRequests.id })",
          "                .from(competitionDocumentRequests)",
          "                .where(inArray(competitionDocumentRequests.registrationId, registrationIds)),",
          "            ),",
          "          )",
        ].join("\n"),
        [
          "          .delete(competitionDocumentRequestFiles)",
          "          .where(",
          "            inArray(",
          "              competitionDocumentRequestFiles.requestId,",
          "              tx",
          "                .select({ id: competitionDocumentRequests.id })",
          "                .from(competitionDocumentRequests)",
          "                .where(inArray(competitionDocumentRequests.registrationId, soloRegistrationIds)),",
          "            ),",
          "          )",
        ].join("\n"),
      ),
    // Post-state, like the two scope probes above: nothing refuses here, and what the suite observes
    // is the file object still in the mocked bucket with its row still in the database.
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", INTEGRATION_TEST],
        /× .*removes the captain's document-request file under a team registration/,
      ),
  },
  {
    name: "a submission is the target's own upload, not everything filed under their registrations",
    klass: "B",
    harmfulMove:
      "scoping the submissions by registration, which is the entry rather than the person. A team " +
      "registration is shared, so its submission row is whichever member uploaded it — and every " +
      "other member's entry under the target's own registrations is the same shape in reverse. Keyed " +
      "by registration, a de-identification deletes a teammate's file and scrubs a teammate's row: " +
      "the person was removed, and someone who was never named in the request lost their work",
    files: [SERVICE],
    // Both halves of the scope reverted, the read and the scrub, because the defect is the key rather
    // than one of its uses: re-pointing only the scrub would leave the read deciding by uploader,
    // which is a shape no reviewer writes. `registrationIds` is still bound and still used by the
    // document-request scrub, so the mutation compiles for a reason rather than by luck (clause 1).
    appliedMarkers: [
      "      .where(inArray(competitionSubmissions.registrationId, registrationIds))\n" +
        "  ).map((row) => row.fileKey);",
      "      .where(inArray(competitionSubmissions.registrationId, registrationIds))\n" +
        "      .returning({ id: competitionSubmissions.id }),",
    ],
    mutate: () => {
      substituteOnce(
        SERVICE,
        "      .from(competitionSubmissions)\n" +
          "      .where(eq(competitionSubmissions.submittedById, accountId))\n" +
          "  ).map((row) => row.fileKey);",
        "      .from(competitionSubmissions)\n" +
          "      .where(inArray(competitionSubmissions.registrationId, registrationIds))\n" +
          "  ).map((row) => row.fileKey);",
      );
      substituteOnce(
        SERVICE,
        "      .set({ fileKey: DEIDENTIFIED_TEXT, fileName: DEIDENTIFIED_TEXT, updatedAt: sql`now()` })\n" +
          "      .where(eq(competitionSubmissions.submittedById, accountId))",
        "      .set({ fileKey: DEIDENTIFIED_TEXT, fileName: DEIDENTIFIED_TEXT, updatedAt: sql`now()` })\n" +
          "      .where(inArray(competitionSubmissions.registrationId, registrationIds))",
      );
    },
    // Class B, and the detector is the post-state B's class names: the suite reads the mocked bucket
    // and the database, so what it observes is the teammate's object gone and the teammate's row
    // scrubbed — not a status code, because nothing refuses here.
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", INTEGRATION_TEST],
        /× .*keeps a teammate's entry when the captain is de-identified/,
      ),
  },
  {
    name: "an object a surviving ledger row still names is kept",
    klass: "B",
    harmfulMove:
      "deleting every object under the personal institution's payment-instructions prefix, including " +
      "the QRIS image a finance snapshot quotes. That snapshot is what an institution's payment " +
      "instructions SAID when a payment was reviewed, and it outlives the account — so the row is " +
      "left citing an image that is gone, on a ledger DEC-0133 forbids removing to tidy it up",
    files: [SERVICE],
    // The subtraction removed rather than its condition inverted: the skip goes whole, so what
    // remains is the delete the skip exists to prevent. The marker is the loop with the guard no
    // longer inside it — an adjacency the unmutated file does not hold.
    appliedMarkers: [
      "      for (const object of objects) {\n        await deleteOne(object.key);\n      }",
    ],
    mutate: () =>
      substituteOnce(
        SERVICE,
        [
          "      for (const object of objects) {",
          "        // A key a surviving row still points at is not this action's to delete. The ledger is",
          "        // append-only (DEC-0133), so the row outlives the account and would be left quoting an",
          "        // image that is gone.",
          "        if (retainedKeys.has(object.key)) {",
          "          continue;",
          "        }",
          "",
          "        await deleteOne(object.key);",
          "      }",
        ].join("\n"),
        [
          "      for (const object of objects) {",
          "        await deleteOne(object.key);",
          "      }",
        ].join("\n"),
      ),
    // Post-state, like the scope probe above: the suite reads the mocked bucket, and the harm is the
    // object that is no longer in it.
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", INTEGRATION_TEST],
        /× .*keeps the QRIS object the snapshot names/,
      ),
  },
  {
    name: "neither internal operator role can be the subject of a de-identification",
    klass: "A1-in",
    harmfulMove:
      "refusing only `platform_ops`, so a finance_ops account is inside the de-identification's reach. " +
      "Both are accounts the platform's own tooling operates rather than consumer accounts it acts " +
      "on, and the one that is left reachable is the one holding the payment ledger",
    files: [SERVICE],
    // The second clause dropped from the condition, so the comparison still happens and `target.role`
    // is still read — the mutation is the reach it leaves open, not a condition that stopped being
    // evaluated.
    appliedMarkers: ['  if (target.role === "platform_ops") {'],
    mutate: () =>
      substituteOnce(
        SERVICE,
        '  if (target.role === "platform_ops" || target.role === "finance_ops") {',
        '  if (target.role === "platform_ops") {',
      ),
    // Class A1-in: the refusal is thrown inside the pre-read's transaction, before the write stage is
    // reached at all, so what the detector can read is the refusal identity — the code the caller
    // receives. The suite asserts the same run's effect as well, and it is empty.
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", INTEGRATION_TEST],
        /× .*refuses 403 when the target is itself an operator account: finance_ops/,
      ),
  },
  {
    name: "an account that captains a team still being formed is not de-identified",
    klass: "A1-in",
    harmfulMove:
      "the refusal dropped, so a team still being assembled is left behind by the run that removes " +
      "its captain. A forming team holds no registration, so nothing in the write set below reaches " +
      "it: the team row survives, naming a captain whose account can never sign in again and who can " +
      "therefore never register it or disband it — the team is stuck in a state only its captain " +
      "could have left",
    files: [SERVICE],
    // The comment, the count and the refusal removed together, so no line is left claiming a check
    // the code no longer makes. The marker is the adjacency that opens in their place — the published
    // -competition refusal directly against the registration read — and it exists only after the
    // mutation, because the unmutated file holds those three blocks in the gap.
    appliedMarkers: [
      "  await assertNoPublishedPersonalCompetition(tx, personalInstitutionId);\n\n  const registrations = await tx",
    ],
    mutate: () =>
      substituteOnce(
        SERVICE,
        [
          "  // A team still being formed is a dependency on the target that the writes cannot resolve, so it",
          "  // has to be registered or disbanded before the account can go.",
          "  const formingTeams = await countFormingTeamsCaptainedBy(tx, accountId);",
          "",
          "  if (formingTeams > 0) {",
          "    throw new DeidentificationError(",
          '      "deidentify_team_captain",',
          "      409,",
          "      `Akun ini kapten dari ${formingTeams} tim yang masih dibentuk. Tim itu harus didaftarkan atau dibubarkan dulu.`,",
          "    );",
          "  }",
          "",
          // The blank line after the refusal, so the removal leaves one blank line between the
          // published-competition refusal and the registration read rather than two.
          "",
        ].join("\n"),
        "",
      ),
    // Class A1-in: the refusal is thrown from inside `assertTargetIsEligible`, which both the pre-read
    // and the writing transaction call, so it fires inside a transaction either way and the rollback
    // is what leaves the account untouched. The detector is the refusal identity — the code the
    // caller receives — and the same test asserts the count in the message, so a run that refused on
    // something else is not read as this refusal.
    detect: async () =>
      fails(
        "npx",
        ["vitest", "run", INTEGRATION_TEST],
        /× .*refuses 409 when the target captains teams that are still forming/,
      ),
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("deidentification-guards", [
    ["npx", ["vitest", "run", UNIT_TEST]],
    ["npx", ["vitest", "run", INTEGRATION_TEST]],
    ["npx", ["vitest", "run", RACE_TEST]],
  ]);
  await runProbes(probes);
}
