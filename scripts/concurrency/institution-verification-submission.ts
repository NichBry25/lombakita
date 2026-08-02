/**
 * INST-VERIF-T1 — live two-connection proof that an institution can hold at most one verification
 * submission awaiting review.
 *
 * The race: two `createVerificationSubmission` calls for the same institution at the same moment
 * (a double-clicked submit button is the realistic case). "No open submission exists" is a cross-row
 * predicate over a row that does not exist yet, so under READ COMMITTED neither transaction can see
 * the other's uncommitted insert and both pass the guard — unless they serialize on the
 * per-institution advisory lock.
 *
 * Two things must hold, and the second is the point of the test: exactly one submission lands, AND
 * the loser fails with the domain error `verification_submission_already_pending` (409). The partial
 * unique index behind the lock would also stop a duplicate, but it would surface as a raw 23505 —
 * a 500 to the caller. Asserting the CODE, not just the row count, is what distinguishes "the lock
 * is working" from "the index is cleaning up after the lock".
 *
 * Usage: node --import tsx scripts/concurrency/institution-verification-submission.ts
 * Exit code: 0 when every assertion holds; 1 on a duplicate, a wrong error, or a raw SQLSTATE.
 */

import {
  assertReadCommitted,
  createChecker,
  describeOutcome,
  finish,
  oneRow,
  openPool,
  race,
} from "./harness";
import { randomUUID } from "crypto";

const ITERATIONS = 5;

const main = async (): Promise<void> => {
  const { client, db } = await openPool();
  const { createVerificationSubmission } = await import(
    "@/server/institution-verification/submission-service"
  );
  const { getRequiredDocumentsForType } = await import(
    "@/server/institution-verification/verification-requirements"
  );
  const { isR2Available } = await import("@/server/storage/r2.client");

  const { check, failureCount } = createChecker();
  const createdUserIds: string[] = [];
  const createdInstitutionIds: string[] = [];

  // createVerificationSubmission presigns an upload URL per document inside the transaction and
  // refuses outright when storage is unconfigured. Without R2 every racer would fail identically
  // for the wrong reason and the run would prove nothing — so refuse to report a result at all.
  if (!isR2Available()) {
    throw new Error(
      "R2 is not configured (R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY). createVerificationSubmission would 503 before reaching the lock.",
    );
  }

  const INSTITUTION_TYPE = "company" as const;
  const documents = getRequiredDocumentsForType(INSTITUTION_TYPE).map((documentType) => ({
    documentType,
    originalFileName: `${documentType}.pdf`,
    fileSizeBytes: 1024,
    contentType: "application/pdf",
  }));

  type SeededInstitution = { slug: string; institutionId: string; ownerId: string };

  const seedOwnedInstitution = async (): Promise<SeededInstitution> => {
    const userId = randomUUID();
    const tag = userId.slice(0, 8);
    await client`
      INSERT INTO users (id, email, username, recruiter_verified_at, recruiter_verification_tier, email_verified)
      VALUES (${userId}, ${`ivconc_${tag}@example.test`}, ${`ivconc_${tag}`}, now(), 'elevated', now())
    `;
    createdUserIds.push(userId);

    const slug = `ivconc-${tag}`;
    const institution = oneRow(await client<{ id: string }[]>`
      INSERT INTO institutions (display_name, slug, institution_type)
      VALUES (${`Inst Verif Conc ${tag}`}, ${slug}, ${INSTITUTION_TYPE})
      RETURNING id
    `, "institution");
    createdInstitutionIds.push(institution.id);

    await client`
      INSERT INTO institution_memberships (institution_id, user_id, membership_role, status)
      VALUES (${institution.id}, ${userId}, 'institution_owner', 'active')
    `;

    return { slug, institutionId: institution.id, ownerId: userId };
  };

  const countSubmissions = async (
    institutionId: string,
    status: "pending_review" | "any",
  ): Promise<number> => {
    const rows =
      status === "any"
        ? await client<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM institution_verification_submissions
            WHERE institution_id = ${institutionId}
          `
        : await client<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM institution_verification_submissions
            WHERE institution_id = ${institutionId} AND status = 'pending_review'
          `;
    return rows[0]?.n ?? 0;
  };

  const runSameInstitutionRace = async (): Promise<void> => {
    console.log(`\n[submit] ${ITERATIONS} iterations, two concurrent submissions per institution`);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seeded = await seedOwnedInstitution();

      const outcome = await race(
        () => createVerificationSubmission(seeded.slug, documents, seeded.ownerId, db),
        () => createVerificationSubmission(seeded.slug, documents, seeded.ownerId, db),
      );

      const pending = await countSubmissions(seeded.institutionId, "pending_review");
      const total = await countSubmissions(seeded.institutionId, "any");

      check(
        outcome.ok === 1 &&
          outcome.failCodes.length === 1 &&
          outcome.failCodes[0] === "verification_submission_already_pending" &&
          outcome.failStatuses[0] === 409 &&
          outcome.other.length === 0 &&
          pending === 1 &&
          total === 1,
        `iter ${i}: ${describeOutcome(outcome)} pending=${pending} total=${total}` +
          ` [want: ok=1 loser=verification_submission_already_pending(409) pending=1 total=1]`,
      );
    }
  };

  // A lock keyed on a constant instead of the institution would serialize every institution's
  // submissions and still pass every assertion above.
  const runCrossInstitutionControl = async (): Promise<void> => {
    console.log(
      `\n[cross-institution] two DIFFERENT institutions submit simultaneously — both must succeed`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const first = await seedOwnedInstitution();
      const second = await seedOwnedInstitution();

      const outcome = await race(
        () => createVerificationSubmission(first.slug, documents, first.ownerId, db),
        () => createVerificationSubmission(second.slug, documents, second.ownerId, db),
      );

      const firstPending = await countSubmissions(first.institutionId, "pending_review");
      const secondPending = await countSubmissions(second.institutionId, "pending_review");
      check(
        outcome.ok === 2 &&
          outcome.failCodes.length === 0 &&
          firstPending === 1 &&
          secondPending === 1,
        `iter ${i}: both succeed (${describeOutcome(outcome)}), each has 1 pending (a=${firstPending}, b=${secondPending})`,
      );
    }
  };

  const cleanup = async (): Promise<void> => {
    if (createdInstitutionIds.length > 0) {
      await client`DELETE FROM institutions WHERE id = ANY(${client.array(createdInstitutionIds)})`;
    }
    if (createdUserIds.length > 0) {
      await client`DELETE FROM users WHERE id = ANY(${client.array(createdUserIds)})`;
    }
    console.log(
      `\nCleaned up ${createdUserIds.length} seeded users and ${createdInstitutionIds.length} institutions.`,
    );
  };

  try {
    await assertReadCommitted(client);
    await runSameInstitutionRace();
    await runCrossInstitutionControl();
  } finally {
    await cleanup();
    await client.end();
  }

  finish(failureCount(), "INST-VERIF-T1");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
