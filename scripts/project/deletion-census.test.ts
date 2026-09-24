import { describe, expect, it } from "vitest";
// @vitest-environment node
//
// The deletion census, held to the schema it derives from.
//
// WHAT THESE TESTS ARE FOR. The census exists so that a deletion procedure can say what it reaches
// and what it leaves behind. Every value in it is derived, so the failure this file is built to
// catch is not "the counts are wrong" — it is "a store was added and the enumeration did not
// notice". Each assertion below fails on a schema change that introduces an unruled store, and
// names the store rather than the shape it broke.
//
// The FK sets are pinned EXACTLY rather than bounded. A blocking edge is the difference between a
// deletion that completes and one that refuses, so a set that gains an edge is a procedure that
// changed its answer, and a test asserting "at least one" would report that as green.

import {
  assertEveryTextColumnIsClassified,
  blockingForeignKeys,
  cascadeClosure,
  cascadeCycles,
  carriesOf,
  COLUMN_CLASSIFICATIONS,
  DeletionCensusRefusal,
  detachingForeignKeys,
  EXTERNAL_STORES,
  holdsNoUserData,
  NOT_PERSONAL_COLUMNS,
  PERSONAL_COLUMNS,
  personalColumnsByTable,
  personalColumnsOf,
  R2_PREFIXES,
  r2UploadModules,
  rowsCanOutliveDeletion,
  rulingsPerStore,
  rulingsWithoutTable,
  schemaForeignKeys,
  schemaTableNames,
  schemaTextCapableColumns,
  staleColumnClassifications,
  survivingPersonalColumns,
  TABLE_RULINGS,
  unclassifiedTextColumns,
  unknownKeyColumns,
  unruledR2Modules,
  unruledTables,
} from "./deletion-census";
import { renderEnumeration } from "./emit-deletion-enumeration";

describe("the derived Postgres population", () => {
  it("derives the table list from the schema rather than from a written-down number", () => {
    // A tripwire, not an assertion about the schema's size: the census reads `schema.ts`, and a
    // refactor that stopped exporting tables from that module would leave every test below passing
    // over an empty population. The floor is deliberately loose so ordinary schema growth does not
    // fail here — the exact membership is what the ruling tests check.
    expect(schemaTableNames().length).toBeGreaterThanOrEqual(40);
    expect(schemaForeignKeys().length).toBeGreaterThanOrEqual(80);
  });

  it("closes the CASCADE walk over `users` only, and does not walk NO ACTION edges", () => {
    const removed = cascadeClosure();

    expect(removed).toContain("users");
    expect(removed).toContain("accounts");
    expect(removed).toContain("competition_registrations");

    // These reference a removed table but with NO ACTION, so a naive walk that ignored the action
    // would place them in the deleted set and the procedure would claim to remove ledger rows.
    expect(removed).not.toContain("finance_payments");
    expect(removed).not.toContain("platform_ops_audit_logs");

    // These reference a removed table with SET NULL, which detaches rather than cascades.
    expect(removed).not.toContain("competitions");
    expect(removed).not.toContain("institution_invitations");
  });

  it("finds no CASCADE cycle, so a single statement can order the walk itself", () => {
    expect(cascadeCycles()).toEqual([]);
  });

  it("pins the foreign keys that make the deletion REFUSE rather than complete", () => {
    // The FK-order requirement, pinned. Each entry is a row that turns `DELETE FROM users` into a
    // referential-integrity violation. A new one means some user population can no longer be
    // deleted, and the procedure has to be told about it before it is run against a live request.
    //
    // `platform_ops_notes.created_by_id` is the entry LAUNCH-D105 was about, and it is here because
    // the filter used to require the SOURCE table to be outside the closure — a property of a whole
    // table, while Postgres enforces the edge per row. This table is in the closure by way of
    // `target_user_id`, so the edge was dropped and the procedure predicted a deletion that the
    // database refuses.
    expect(
      blockingForeignKeys().map((key) => `${key.sourceTable}.${key.sourceColumns.join("+")}`),
    ).toEqual([
      "finance_fee_disclosure_acknowledgements.acknowledged_by_user_id",
      "finance_manual_payment_proof_attempts.submitted_by_user_id",
      "finance_manual_payment_proof_attempts.reviewer_user_id",
      "finance_manual_payment_proofs.submitted_by_user_id",
      "finance_manual_payment_proofs.reviewer_user_id",
      "finance_payment_events.actor_user_id",
      "finance_payments.payer_user_id",
      "finance_payments.competition_registration_id",
      "platform_ops_audit_logs.actor_user_id",
      "platform_ops_audit_logs.target_user_id",
      "platform_ops_notes.created_by_id",
    ]);

    // The catalog oracle measures each of these against a live database and asserts the two sets
    // are equal; this pin is what makes a CHANGE visible in a unit run with no database attached.
  });

  it("pins the foreign keys that detach a pointer instead of taking the row", () => {
    // The same per-row correction, in the other direction. The six entries whose source table is
    // INSIDE the closure are the ones the old filter dropped: a seat on another member's
    // `institution_memberships` row, an invitation on another captain's team, a request on another
    // participant's registration and a review on another recruiter's submission all survive the
    // deletion of the person who was named on them.
    expect(
      detachingForeignKeys().map((key) => `${key.sourceTable}.${key.sourceColumns.join("+")}`),
    ).toEqual([
      "competition_document_requests.requested_by_user_id",
      "competition_document_requests.reviewed_by_user_id",
      "competitions.created_by_user_id",
      "institution_audit_logs.actor_user_id",
      "institution_audit_logs.target_membership_id",
      "institution_invitations.invited_by_user_id",
      "institution_invitations.target_user_id",
      "institution_memberships.invited_by_user_id",
      "institution_verification_audit.actor_user_id",
      "institution_verification_submissions.submitted_by_user_id",
      "institution_verification_submissions.reviewer_user_id",
      "recruiter_verification_submissions.reviewer_user_id",
      "team_invitations.invited_by_user_id",
      "team_invitations.target_user_id",
    ]);

    // `competition_document_requests` used to be asserted ABSENT from this list on the reasoning
    // that its rows are deleted rather than detached. That reasoning is the defect: the table is in
    // the closure, and a request on somebody else's registration is a row the closure never
    // reaches. It is in the list above, and the oracle observed it nulled.
    expect(cascadeClosure()).toContain("competition_document_requests");
  });
});

describe("the rulings cover the derived population", () => {
  it("refuses to enumerate a table it has no ruling for", () => {
    // The refusal is the mechanism, so it is exercised directly: a synthetic derivation with an
    // extra member must be reported by name, not skipped.
    expect(unruledTables(["users", "a_table_invented_after_this_was_written"])).toEqual([
      "a_table_invented_after_this_was_written",
    ]);

    const refusal = new DeletionCensusRefusal("a_table_invented_after_this_was_written", "table");
    expect(refusal.message).toContain("a_table_invented_after_this_was_written");
  });

  it("has a ruling for every table the schema declares", () => {
    // THE ASSERTION A NEW TABLE FAILS. Adding a table to `schema.ts` without adding a ruling here
    // reddens this by name.
    expect(unruledTables()).toEqual([]);
  });

  it("names no table the schema does not declare, so a rename cannot retire a ruling quietly", () => {
    expect(rulingsWithoutTable()).toEqual([]);
  });

  it("rules each store exactly once, so no store carries two answers", () => {
    const doubled = [...rulingsPerStore().entries()]
      .filter(([, rulings]) => rulings.length !== 1)
      .map(([store, rulings]) => `${store} x${rulings.length}`);

    expect(doubled).toEqual([]);
  });

  it("rules a table `removed` exactly when no row of it can outlive the deletion", () => {
    // The equivalence, in both directions, across two derivations that do not read each other: the
    // ruling's own `survival` field and the edge walk behind `rowsCanOutliveDeletion`. A table
    // claimed removed while a row of it survives is a procedure that reports deleting data it left
    // behind; a survivor claimed for a table nothing of which survives is a listing that reads as
    // residue and is not.
    for (const ruling of TABLE_RULINGS) {
      expect(
        ruling.survival === "removed",
        `${ruling.store}: \`survival\` and \`rowsCanOutliveDeletion\` disagree`,
      ).toBe(!rowsCanOutliveDeletion(ruling.store));
    }
  });

  it("rules a table `removed` only when the CASCADE closure actually reaches it", () => {
    const removed = new Set(cascadeClosure());

    expect(
      TABLE_RULINGS.filter((ruling) => ruling.survival === "removed")
        .map((ruling) => ruling.store)
        .filter((store) => !removed.has(store)),
    ).toEqual([]);
  });

  it("accounts for every closure table the deletion does not empty", () => {
    // The closure is not the same thing as the removal set any more, and the difference is the
    // whole of LAUNCH-D105: four closure tables are sources of a detaching edge, and one is a
    // source of a blocking edge. Enumerated rather than counted, so the fifth one arriving is a
    // failing test naming itself rather than a total that shifted by one.
    const survivorsInsideTheClosure = TABLE_RULINGS.filter(
      (ruling) => ruling.survival !== "removed" && cascadeClosure().includes(ruling.store),
    ).map((ruling) => `${ruling.store}: ${ruling.survival}`);

    expect(survivorsInsideTheClosure).toEqual([
      "competition_document_requests: detached",
      "institution_memberships: detached",
      "recruiter_verification_submissions: detached",
      "team_invitations: detached",
      "platform_ops_notes: blocks-deletion",
    ]);
  });

  it("says why every surviving table survives", () => {
    // The assertion here used to be `reason.length > 40`, which a forty-one-character sentence
    // about the wrong table passes and a correct short one fails — a character count is not a
    // property of being right. It is replaced by structural claims that can be checked: the
    // equivalence above (`removed` against `rowsCanOutliveDeletion`), the closure-survivor
    // enumeration, and the pinned carry sets below. What remains here is only that a ruling
    // answered the question at all; the answer's quality is what a reader is for.
    for (const ruling of TABLE_RULINGS) {
      expect(ruling.reason.trim().length, `${ruling.store} must say why`).toBeGreaterThan(0);
    }
  });

  it("derives what survives with a row from the table's own columns", () => {
    // `carriesOf` is the derivation and this pins its OUTPUT, which is the part a reader has to be
    // able to disagree with. Every entry is the full personal-column list of a table a row of which
    // can still be there after the statement — no hand-written list is consulted, so a ruling
    // cannot be right about the row and wrong about the columns on it, which is the exact shape of
    // the eight wrong `holds-no-user-data` rulings LAUNCH-D100 found.
    expect(
      survivingPersonalColumns().map((entry) => `${entry.table}: ${entry.columns.join(", ")}`),
    ).toEqual([
      "competition_document_requests: instructions, review_note, title",
      "competition_prizes: description, rank_label, title",
      "competition_rounds: description, platform_label, title",
      "competition_tags: tag",
      "competitions: description, eligibility_note, slug, title",
      "finance_fee_accruals: reason",
      "finance_manual_payment_proof_attempts: original_file_name, verdict_reason",
      "finance_manual_payment_proofs: original_file_name, rejection_reason",
      "finance_payment_events: metadata, reason",
      "finance_payment_instruction_snapshots: account_holder_name, account_number, bank_name, instructions_note",
      "institution_audit_logs: metadata",
      "institution_invitations: invited_email",
      "institution_payment_instructions: account_holder_name, account_number, bank_name, instructions_note",
      "institution_social_links: url",
      "institution_verification_audit: reason",
      "institution_verification_documents: content_type, document_type, original_file_name",
      "institution_verification_submissions: proposed_display_name, reviewer_notes",
      "institutions: about, contact_email, contact_name, contact_phone, description, display_name, rejection_reason, slug, suspension_reason, website_url",
      "platform_ops_audit_logs: metadata, reason",
      "platform_ops_notes: note",
      "recruiter_verification_submissions: corporate_email, full_name, mobile_number, rejection_reason",
      "team_invitations: invited_email",
      "verification_tokens: identifier, token",
    ]);

    // The survivors carrying NOTHING are pinned too, because they are the other half of the same
    // claim: `competition_saves` has no personal column at all, so its emptiness is a fact about
    // its columns rather than a ruling that nothing of it survives.
    expect(
      TABLE_RULINGS.filter(
        (ruling) => ruling.survival !== "removed" && carriesOf(ruling.store).length === 0,
      ).map((ruling) => ruling.store),
    ).toEqual([
      "finance_fee_rules",
      "infrastructure_probe",
      "institution_memberships",
      // Two tables that BLOCK the deletion while holding no classified personal column of their
      // own: `finance_payments` and `finance_fee_disclosure_acknowledgements` name a user through
      // a uuid, which is not a text-capable type. The row still refuses the statement — which is
      // the reminder that "holds no personal data" and "can be deleted" are different questions.
      "finance_payments",
      "finance_fee_disclosure_acknowledgements",
    ]);
  });
});

describe("the rendered enumeration", () => {
  const document = renderEnumeration();

  it("names every table the schema declares, so no store is missing from the artifact", () => {
    const absent = schemaTableNames().filter((table) => !document.includes(`\`${table}\``));

    expect(absent).toEqual([]);
  });

  describe("the column classification", () => {
    it("classifies every text-capable column, and only text-capable columns", () => {
      // THE ASSERTION A NEW COLUMN FAILS. Both directions of the same refusal: a text-capable column
      // with no classification, and a classification naming a column the schema does not have or that
      // is not text-capable. Either one leaves a claim that cannot be checked against anything, and a
      // listing that keeps it reads as coverage.
      expect(unclassifiedTextColumns()).toEqual([]);
      expect(staleColumnClassifications()).toEqual([]);

      // A tripwire so the two assertions above cannot pass over an empty population — every one of
      // them is vacuously true if `getSQLType()` stopped returning anything the predicate knows.
      expect(schemaTextCapableColumns().length).toBeGreaterThanOrEqual(250);
      expect(PERSONAL_COLUMNS.length + NOT_PERSONAL_COLUMNS.length).toBe(
        schemaTextCapableColumns().length,
      );
    });

    it("refuses by name when a single classification is removed", () => {
      // Rule 33: the input is built through the real production path — the schema's own column list —
      // and only the classification list is perturbed, so this measures the coverage check rather
      // than a hand-built population. `institutions.about` is the column the demonstration showed
      // surviving on a real deletion; if the check cannot notice that one going missing it cannot
      // notice any.
      const columns = schemaTextCapableColumns();
      const without = COLUMN_CLASSIFICATIONS.filter(
        (entry) => entry.column !== "institutions.about",
      );

      expect(unclassifiedTextColumns(columns, without)).toEqual(["institutions.about"]);

      // And the refusal is thrown by the deriving path, not merely returned by a helper.
      expect(() => personalColumnsByTable(without)).toThrow(DeletionCensusRefusal);
    });

    it("refuses a classification naming a column that is not text-capable", () => {
      // The same defect from the other side. `users.created_at` is a real column and not a
      // text-capable one, so a classification of it is a claim about a column no reader can verify.
      const withStray = [
        ...COLUMN_CLASSIFICATIONS,
        { column: "users.created_at", kind: "not-personal", reason: "not a text column" } as const,
      ];

      expect(staleColumnClassifications(schemaTextCapableColumns(), withStray)).toEqual([
        "users.created_at",
      ]);
    });

    it("gives every `not-personal` column the reason it is not personal", () => {
      // The reason is the whole content of a `not-personal` classification: without one the entry is
      // indistinguishable from a column nobody got round to. `personal` owes no reason, because the
      // default direction is the safe one.
      const unexplained = NOT_PERSONAL_COLUMNS.filter(
        (entry) => entry.reason.trim().length === 0,
      ).map((entry) => entry.column);

      expect(unexplained).toEqual([]);

      for (const entry of NOT_PERSONAL_COLUMNS) {
        expect(entry.reason.length, `${entry.column} must say why`).toBeGreaterThan(10);
      }
    });

    it("refuses a `not-personal` classification that does not say why", () => {
      // The third arm of the same guard, and the one no other test reaches: the reason IS the content
      // of a `not-personal` entry, so an entry without one is a column nobody got round to, wearing
      // the ruling of a column somebody considered. Rule 32: this arm is asserted through the guard
      // that throws rather than through the list it reads, so deleting the arm fails here.
      const withSilentEntry = [
        ...COLUMN_CLASSIFICATIONS.map((entry) =>
          entry.column === "institutions.about"
            ? ({ ...entry, kind: "not-personal", reason: "   " } as const)
            : entry,
        ),
      ];

      expect(() =>
        assertEveryTextColumnIsClassified(schemaTextCapableColumns(), withSilentEntry),
      ).toThrow(/no ruling for reason for a not-personal column "institutions.about"/);
    });

    it("answers every classified column exactly once", () => {
      const counts = new Map<string, number>();
      for (const entry of COLUMN_CLASSIFICATIONS) {
        counts.set(entry.column, (counts.get(entry.column) ?? 0) + 1);
      }

      expect(
        [...counts]
          .filter(([, count]) => count !== 1)
          .map(([column, count]) => `${column} x${count}`),
      ).toEqual([]);
    });

    it("derives `holds no user data` from the columns rather than ruling it per table", () => {
      // THE LAUNCH-D100 CHANGE, and the set is pinned because it is what the procedure's residue
      // section is written against. Eight of the ten tables the hand rulings called clean are not in
      // it: `competition_prizes` holds `title`, `description` and `rank_label`;
      // `institution_verification_documents` holds the uploader's `original_file_name`.
      const clean = schemaTableNames().filter(holdsNoUserData);

      expect(clean.sort()).toEqual([
        "competition_saves",
        "finance_fee_disclosure_acknowledgements",
        "finance_fee_rules",
        "finance_payments",
        "infrastructure_probe",
        "institution_memberships",
        "mfa_factors",
        "mfa_recovery_codes",
        "team_memberships",
        "user_email_verification_tokens",
        "user_password_credentials",
        "user_platform_roles",
      ]);

      // Two of the ten the hand rulings got right, named so the fact that the derivation agrees with
      // them is visible rather than assumed.
      expect(holdsNoUserData("finance_fee_rules")).toBe(true);
      expect(holdsNoUserData("competition_prizes")).toBe(false);
      expect(personalColumnsOf("competition_prizes")).toEqual([
        "description",
        "rank_label",
        "title",
      ]);
    });

    it("carries the free-text columns the demonstration found surviving, not only the key columns", () => {
      // The columns the seeded deletion left behind on a real run, asserted through the derivation.
      // Neither is a foreign key: `competitions.created_by_user_id` had already nulled, and
      // `institutions` has no foreign key to `users` at all. The FK graph could not have named them.
      expect(carriesOf("competitions")).toContain("title");
      expect(carriesOf("institutions")).toContain("about");

      // And the column the Auth.js adapter table holds with nothing reaching it.
      expect(carriesOf("verification_tokens")).toEqual(["identifier", "token"]);
    });
  });

  it("names every R2 prefix and every external store", () => {
    // A section the renderer drops is a store the reader never learns about, and the artifact is the
    // only place a store appears as prose. The tests above prove the census KNOWS; these prove the
    // document SAYS.
    const missingPrefixes = R2_PREFIXES.map((entry) => entry.prefix).filter(
      (prefix) => !document.includes(prefix),
    );
    const missingStores = EXTERNAL_STORES.map((store) => store.store).filter(
      (store) => !document.includes(store),
    );

    expect(missingPrefixes).toEqual([]);
    expect(missingStores).toEqual([]);
  });

  it("renders the same bytes on every run, so a diff means a change and not a reordering", () => {
    expect(renderEnumeration()).toBe(document);
  });
});

describe("the stores outside Postgres", () => {
  it("derives the R2 surface from the writers, not from a list of prefixes", () => {
    // A tripwire so the coverage check below cannot pass over an empty population.
    expect(r2UploadModules().length).toBeGreaterThanOrEqual(6);
  });

  it("has a declared prefix for every module that mints a presigned PUT", () => {
    // THE SECOND ASSERTION A NEW STORE FAILS. A new upload surface calls `generatePresignedPutUrl`,
    // lands here, and is refused until someone says whether a deletion reaches it.
    expect(unruledR2Modules()).toEqual([]);
  });

  it("pins the user-scoped prefixes the procedure actually walks", () => {
    const userScoped = R2_PREFIXES.filter((entry) => entry.scope === "user").map(
      (entry) => entry.prefix,
    );

    expect(userScoped).toEqual([
      "avatars/{userId}/",
      "banners/{userId}/",
      "resumes/{userId}/",
      "profile-certifications/{userId}/",
      "recruiter-verification/{userId}/{submissionId}/",
    ]);
  });

  it("pins the prefixes a deletion has to remove, as a set, not as a count", () => {
    // This is the population the procedure's capture step is held against: every prefix marked here
    // must appear in that step. A prefix arriving with no answer fails this, and one flipping its
    // answer flips it visibly rather than shifting a number nobody reads.
    const reached = R2_PREFIXES.filter((entry) => entry.reachedByDeletion).map(
      (entry) => entry.prefix,
    );
    const notReached = R2_PREFIXES.filter((entry) => !entry.reachedByDeletion).map(
      (entry) => entry.prefix,
    );

    expect(reached).toEqual([
      "avatars/{userId}/",
      "banners/{userId}/",
      "resumes/{userId}/",
      "profile-certifications/{userId}/",
      "recruiter-verification/{userId}/{submissionId}/",
      "submissions/{competitionId}/{registrationId}/",
      "registration-documents/{competitionId}/{registrationId}/{requestId}/",
    ]);
    expect(notReached).toEqual([
      "payment-proofs/{competitionId}/{paymentId}/",
      "payment-instructions/{institutionId}/",
      "institution-logos/{institutionId}/",
      "institution-banners/{institutionId}/",
      "verification/{institutionId}/{submissionId}/",
    ]);

    // The two sets partition the declared prefixes, so a prefix cannot be silently in neither.
    expect(reached.length + notReached.length).toBe(R2_PREFIXES.length);
  });

  it("states the submission layout the code writes, not the one DEC-0066 documents", () => {
    // DEC-0066's own row says `submissions/{registrationId}/`. It has been wrong since the
    // competition segment was added and `submission-constants.ts` calls that segment load-bearing.
    // A procedure walking the documented prefix lists zero objects and reports success, so the
    // census takes the three-segment form and this pins the divergence so it cannot be reverted to
    // match the stale document.
    const submissions = R2_PREFIXES.find((entry) => entry.prefix.startsWith("submissions/"));

    expect(submissions?.prefix).toBe("submissions/{competitionId}/{registrationId}/");
  });

  it("names an object key column that exists, so a rename cannot leave a stale route", () => {
    // A renamed column would leave the procedure reading a key that is no longer there and finding
    // nothing, which reads exactly like a user who uploaded nothing.
    expect(unknownKeyColumns()).toEqual([]);
  });

  it("pins which prefixes have their object keys on rows inside the deletion", () => {
    const keyColumns = R2_PREFIXES.filter((entry) => entry.keyColumns.length > 0).map(
      (entry) => entry.prefix,
    );

    // Every one of these takes its key from a closure row. The procedure has to read them before it
    // deletes anything, and this pins WHICH prefixes that ordering constraint applies to, so a new
    // prefix cannot arrive without an answer.
    expect(keyColumns).toEqual([
      "avatars/{userId}/",
      "banners/{userId}/",
      "resumes/{userId}/",
      "profile-certifications/{userId}/",
      "recruiter-verification/{userId}/{submissionId}/",
      "submissions/{competitionId}/{registrationId}/",
      "registration-documents/{competitionId}/{registrationId}/{requestId}/",
      "payment-proofs/{competitionId}/{paymentId}/",
      "payment-instructions/{institutionId}/",
      "institution-logos/{institutionId}/",
      "institution-banners/{institutionId}/",
      "verification/{institutionId}/{submissionId}/",
    ]);
  });

  it("states how a deletion reaches every prefix, including the ones it does not", () => {
    for (const entry of R2_PREFIXES) {
      expect(entry.reachedBy.length, `${entry.prefix} must say how it is reached`).toBeGreaterThan(
        30,
      );
      expect(entry.reason.length, `${entry.prefix} must say what it holds`).toBeGreaterThan(20);
    }
  });

  it("answers every non-Postgres store individually, reached or not", () => {
    for (const store of EXTERNAL_STORES) {
      expect(store.reason.length, `${store.store} must say why`).toBeGreaterThan(40);
      expect(store.address.length, `${store.store} must say how it is addressed`).toBeGreaterThan(
        0,
      );
    }

    // The stores that are NOT reached are the ones the policy statement has to name, so they are
    // pinned as a set: a store quietly flipping to `reached` would shrink the honest answer.
    expect(EXTERNAL_STORES.filter((store) => !store.reached).map((store) => store.store)).toEqual([
      "Meilisearch index `competitions`",
      "Redis rate-limit counters",
      "Redis OAuth single-use nonce",
      "Redis MFA elevation grant",
      "BullMQ job payloads",
      "Resend message log",
      "Sentry events",
    ]);
  });
});
