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

import { describe, expect, it } from "vitest";
import {
  blockingForeignKeys,
  cascadeClosure,
  cascadeCycles,
  DeletionCensusRefusal,
  detachingForeignKeys,
  EXTERNAL_STORES,
  R2_PREFIXES,
  r2UploadModules,
  rulingsPerStore,
  rulingsWithoutTable,
  schemaColumns,
  schemaForeignKeys,
  schemaTableNames,
  TABLE_RULINGS,
  unknownCarriedColumns,
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
    ]);
  });

  it("pins the foreign keys that detach a pointer instead of taking the row", () => {
    expect(
      detachingForeignKeys().map((key) => `${key.sourceTable}.${key.sourceColumns.join("+")}`),
    ).toEqual([
      "competitions.created_by_user_id",
      "institution_audit_logs.actor_user_id",
      "institution_audit_logs.target_membership_id",
      "institution_invitations.invited_by_user_id",
      "institution_invitations.target_user_id",
      "institution_verification_audit.actor_user_id",
      "institution_verification_submissions.submitted_by_user_id",
      "institution_verification_submissions.reviewer_user_id",
    ]);

    // `competition_document_requests` carries the same two SET NULL columns and is deliberately
    // absent: it is INSIDE the closure, so its rows are deleted rather than detached. Listed here
    // because the pair is otherwise indistinguishable from an omission.
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

  it("rules a table `removed` only when the CASCADE closure actually reaches it", () => {
    const removed = new Set(cascadeClosure());
    const claimed = TABLE_RULINGS.filter((ruling) => ruling.survival === "removed").map(
      (ruling) => ruling.store,
    );

    // Both directions. A store claimed removed but not in the closure is a procedure that reports
    // deleting rows it never touches; a store in the closure with no ruling is already caught above,
    // so this closes the pair.
    expect(claimed.filter((store) => !removed.has(store))).toEqual([]);
    expect([...removed].filter((store) => !claimed.includes(store))).toEqual([]);
  });

  it("gives a `removed` store no surviving personal data, and a survivor its columns", () => {
    for (const ruling of TABLE_RULINGS) {
      if (ruling.survival === "removed") {
        expect(ruling.carries, `${ruling.store} is removed and cannot carry anything`).toEqual([]);
        continue;
      }
      expect(
        ruling.reason.length,
        `${ruling.store} survives and must say why`,
      ).toBeGreaterThan(40);
    }
  });

  it("names only columns the table actually has, so a rename cannot leave a stale claim", () => {
    const columns = schemaColumns();
    const wrong = TABLE_RULINGS.flatMap((ruling) =>
      unknownCarriedColumns(ruling, columns).map((column) => `${ruling.store}.${column}`),
    );

    expect(wrong).toEqual([]);
  });

  it("records personal data surviving outside the tables it deletes", () => {
    const survivals = TABLE_RULINGS.filter(
      (ruling) => ruling.survival !== "removed" && ruling.carries.length > 0,
    ).map((ruling) => `${ruling.store}: ${ruling.carries.join(", ")}`);

    // Pinned because these are the rows the policy's promise has to be read against. An email
    // address in `institution_invitations` and a payer pointer in `finance_payments` are the two
    // that cannot be removed by any procedure that respects DEC-0133.
    expect(survivals).toEqual([
      "finance_payments: payer_user_id",
      "finance_payment_events: actor_user_id, metadata",
      "finance_fee_disclosure_acknowledgements: acknowledged_by_user_id",
      "finance_manual_payment_proofs: submitted_by_user_id, r2_key, original_file_name",
      "finance_manual_payment_proof_attempts: submitted_by_user_id, reviewer_user_id, r2_key, original_file_name",
      "platform_ops_audit_logs: actor_user_id, target_user_id, metadata",
      "institution_audit_logs: metadata",
      "institution_invitations: invited_email",
    ]);
  });
});

describe("the rendered enumeration", () => {
  const document = renderEnumeration();

  it("names every table the schema declares, so no store is missing from the artifact", () => {
    const absent = schemaTableNames().filter((table) => !document.includes(`\`${table}\``));

    expect(absent).toEqual([]);
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
      expect(store.address.length, `${store.store} must say how it is addressed`).toBeGreaterThan(0);
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
