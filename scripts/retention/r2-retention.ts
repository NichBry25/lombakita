/**
 * DOCVERIF-T4, SUBMISSION-T1, RECRUITER-DOC-T1 — live proof that the retention purges and the
 * orphan sweeps actually delete bytes from R2, and that they leave behind exactly what they are
 * supposed to leave behind.
 *
 * Everything these three debt items cover is unit-tested with `listObjects` and `deleteObject`
 * mocked, which means the tests assert the SHAPE of the call and nothing about the outcome. A purge
 * that lists the wrong prefix, or deletes nothing, or deletes the finalized entry it exists to
 * protect, passes that suite. The only assertion that settles it is reading the bucket back
 * afterwards, which is what this script does.
 *
 * The load-bearing claim in each part is the one a row-driven implementation would get wrong:
 *
 *   Documents (DEC-0122): the purge deletes BY STORAGE PREFIX, so an object PUT and never
 *     finalized — one no row has ever referenced — goes with the rest. The request row SURVIVES
 *     its files, because "was this participant verified, by whom, when" must stay answerable after
 *     the ID card is gone.
 *   Submissions (DEC-0126): a FINALIZED submission is never purged at any age. The keep-set is
 *     built from finalized rows and everything else under the prefix is deleted, so a forgotten
 *     object is reclaimed while the participant's entry is untouched.
 *   Recruiter verification (DEC-0111): the orphan sweep is age-guarded, so an upload still inside
 *     its presign window survives and is not deleted out from under a user mid-upload.
 *
 * Each part seeds its own competition/account, uploads REAL bytes through the REAL presigned PUT
 * path, and cleans up after itself. Nothing here touches an existing row.
 *
 * Usage: node --import tsx scripts/retention/r2-retention.ts
 * Requires: local Postgres + R2 credentials in .env.local (R2_* — the same four the app uses).
 * Exit code: 0 when every assertion holds; 1 otherwise.
 */

import { createChecker, finish, oneRow, openPool } from "../lib/live-harness";
import { randomUUID } from "crypto";

// Comfortably past both 90-day grace windows, so a competition seeded with this event_end_at is
// unambiguously due rather than sitting on the boundary.
const LONG_PAST_DAYS = 200;
// ISO strings rather than Date objects: these are interpolated into tagged-template SQL, and
// postgres.js cannot infer a parameter type for a bare Date when statement preparation is off.
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

// Long enough that a slow seed cannot expire a URL mid-run; short enough to be unremarkable.
const PUT_URL_EXPIRY_SECONDS = 300;

// A real one-page PDF. The magic bytes matter: the upload paths detect content type from the
// stored object, so a placeholder string would be rejected before anything reached the bucket.
const pdfBytes = (): Buffer =>
  Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
      "trailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1",
  );

const main = async (): Promise<void> => {
  const { client, db } = await openPool();

  const { generatePresignedPutUrl, isR2Available, listObjects, deleteObject } =
    await import("@/server/storage/r2.client");

  if (!isR2Available()) {
    throw new Error(
      "R2 is not configured — set R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in .env.local. " +
        "Without real storage this script would report passes that mean nothing.",
    );
  }

  const { buildCompetitionObjectPrefix, buildRequestObjectPrefix, DOCUMENT_RETENTION_GRACE_DAYS } =
    await import("@/server/registration-documents/registration-document-core");
  const { listCompetitionsDueForDocumentPurge, purgeDocumentsForCompetition } =
    await import("@/server/registration-documents/registration-document-service");
  const { buildSubmissionCompetitionPrefix, buildSubmissionRegistrationPrefix } =
    await import("@/server/submissions/submission-constants");
  const { listCompetitionsDueForSubmissionPurge, purgeUnfinalizedSubmissionsForCompetition } =
    await import("@/server/submissions/submission-service");
  const { sweepOrphanedSubmissionObjects } =
    await import("@/server/recruiter-verification/recruiter-verification-service");

  const { check, failureCount } = createChecker();
  const createdUserIds: string[] = [];
  const createdInstitutionIds: string[] = [];
  const strayKeys: string[] = [];

  // ---- seeding -------------------------------------------------------------------------------

  const seedUser = async (prefix: string): Promise<string> => {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await client`
      INSERT INTO users (id, email, username, candidate_verified_at, email_verified)
      VALUES (${id}, ${`${prefix}_${tag}@example.test`}, ${`${prefix}_${tag}`}, now(), now())
    `;
    createdUserIds.push(id);
    return id;
  };

  const seedCompetition = async (
    label: string,
    eventEndAt: string | null,
  ): Promise<{ competitionId: string; organizerId: string }> => {
    const organizerId = await seedUser(`${label}_org`);
    const tag = organizerId.slice(0, 8);

    const institution = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO institutions (display_name, slug, institution_type)
        VALUES (${`Retention ${tag}`}, ${`retention-${tag}`}, 'company')
        RETURNING id
      `,
      "institution",
    );
    createdInstitutionIds.push(institution.id);

    await client`
      INSERT INTO institution_memberships (institution_id, user_id, membership_role, status)
      VALUES (${institution.id}, ${organizerId}, 'institution_owner', 'active')
    `;

    const competition = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO competitions (institution_id, created_by_user_id, slug, title, status, event_end_at)
        VALUES (${institution.id}, ${organizerId}, ${`${label}-${tag}`}, ${`Retention ${tag}`}, 'published', ${eventEndAt})
        RETURNING id
      `,
      "competition",
    );

    return { competitionId: competition.id, organizerId };
  };

  type SeededRegistration = { registrationId: string; candidateId: string };

  const seedRegistration = async (competitionId: string): Promise<SeededRegistration> => {
    const candidateId = await seedUser("retention_cand");
    const registration = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO competition_registrations (competition_id, student_id)
        VALUES (${competitionId}, ${candidateId})
        RETURNING id
      `,
      "registration",
    );
    return { registrationId: registration.id, candidateId };
  };

  // Uploads real bytes through the real presigned PUT. Returns the key so a caller can decide
  // whether to also write a row for it — an upload with no row is exactly the orphan case.
  const putObject = async (key: string): Promise<string> => {
    const url = await generatePresignedPutUrl(key, "application/pdf", PUT_URL_EXPIRY_SECONDS);
    const response = await fetch(url, {
      method: "PUT",
      body: new Uint8Array(pdfBytes()),
      headers: { "content-type": "application/pdf" },
    });
    if (!response.ok) {
      throw new Error(
        `PUT ${key} failed with ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    }
    strayKeys.push(key);
    return key;
  };

  const keysUnder = async (prefix: string): Promise<string[]> =>
    (await listObjects(prefix)).map((object) => object.key).sort();

  // ---- part A: participant document purge (DOCVERIF-T4) ----------------------------------------

  console.log(
    `\n[documents] purge deletes every object under the competition prefix, keeps the request row`,
  );
  console.log(
    `  grace window = ${DOCUMENT_RETENTION_GRACE_DAYS} days; seeded event_end_at = ${LONG_PAST_DAYS} days ago`,
  );

  const agedDocComp = await seedCompetition("retdoc-aged", daysAgo(LONG_PAST_DAYS));
  const docRegistration = (await seedRegistration(agedDocComp.competitionId)).registrationId;

  const docRequest = oneRow(
    await client<{ id: string }[]>`
      INSERT INTO competition_document_requests
        (registration_id, title, due_at, status, requested_by_user_id, reviewed_by_user_id, reviewed_at, review_note)
      VALUES
        (${docRegistration}, 'Kartu pelajar', ${daysAgo(LONG_PAST_DAYS + 10)}, 'accepted',
         ${agedDocComp.organizerId}, ${agedDocComp.organizerId}, ${daysAgo(LONG_PAST_DAYS + 5)}, 'Sesuai')
      RETURNING id
    `,
    "document request",
  );

  const docPrefix = buildRequestObjectPrefix(
    agedDocComp.competitionId,
    docRegistration,
    docRequest.id,
  );

  // Two referenced files...
  for (let index = 0; index < 2; index += 1) {
    const key = await putObject(`${docPrefix}${randomUUID()}`);
    await client`
      INSERT INTO competition_document_request_files
        (request_id, r2_key, original_file_name, file_size_bytes, content_type)
      VALUES (${docRequest.id}, ${key}, ${`kartu-${index}.pdf`}, ${pdfBytes().length}, 'application/pdf')
    `;
  }
  // ...and one object nothing in the database has ever heard of. A purge driven from the file rows
  // instead of the prefix leaves this behind forever, which is the defect the layout exists to stop.
  const docOrphanKey = await putObject(`${docPrefix}${randomUUID()}`);

  // Two controls that must NOT be selected for purge.
  const recentDocComp = await seedCompetition("retdoc-recent", daysAgo(10));
  const nullEndDocComp = await seedCompetition("retdoc-nullend", null);
  for (const control of [recentDocComp, nullEndDocComp]) {
    const { registrationId } = await seedRegistration(control.competitionId);
    const request = oneRow(
      await client<{ id: string }[]>`
        INSERT INTO competition_document_requests (registration_id, title, due_at, requested_by_user_id)
        VALUES (${registrationId}, 'Kartu pelajar', ${daysAgo(1)}, ${control.organizerId})
        RETURNING id
      `,
      "control document request",
    );
    const key = await putObject(
      `${buildRequestObjectPrefix(control.competitionId, registrationId, request.id)}${randomUUID()}`,
    );
    await client`
      INSERT INTO competition_document_request_files
        (request_id, r2_key, original_file_name, file_size_bytes, content_type)
      VALUES (${request.id}, ${key}, 'kartu.pdf', ${pdfBytes().length}, 'application/pdf')
    `;
  }

  const docsDue = await listCompetitionsDueForDocumentPurge(DOCUMENT_RETENTION_GRACE_DAYS, db);
  check(docsDue.includes(agedDocComp.competitionId), "DOC-R01  aged competition is due for purge");
  check(
    !docsDue.includes(recentDocComp.competitionId),
    "DOC-R02  competition inside the grace window is NOT due",
  );
  check(
    !docsDue.includes(nullEndDocComp.competitionId),
    "DOC-R03  competition with no event_end_at is SKIPPED, never purged",
  );

  const docKeysBefore = await keysUnder(buildCompetitionObjectPrefix(agedDocComp.competitionId));
  check(
    docKeysBefore.length === 3,
    `DOC-R04  3 objects in the bucket before purge (got ${docKeysBefore.length})`,
  );

  const docOutcome = await purgeDocumentsForCompetition(agedDocComp.competitionId, db);
  check(
    docOutcome.objectsDeleted === 3,
    `DOC-R05  purge deleted 3 objects including the unreferenced one (got ${docOutcome.objectsDeleted})`,
  );
  check(
    docOutcome.fileRowsDeleted === 2,
    `DOC-R06  purge deleted 2 file rows (got ${docOutcome.fileRowsDeleted})`,
  );

  const docKeysAfter = await keysUnder(buildCompetitionObjectPrefix(agedDocComp.competitionId));
  check(
    docKeysAfter.length === 0,
    `DOC-R07  bucket prefix is EMPTY after purge — read back from R2 (got ${docKeysAfter.length}: ${docKeysAfter.join(", ")})`,
  );
  check(
    !docKeysAfter.includes(docOrphanKey),
    "DOC-R08  the never-referenced object was reclaimed (prefix-driven, not row-driven)",
  );

  const survivingRequest = oneRow(
    await client<
      { status: string; reviewed_by_user_id: string | null; review_note: string | null }[]
    >`
      SELECT status, reviewed_by_user_id, review_note
      FROM competition_document_requests WHERE id = ${docRequest.id}
    `,
    "surviving request",
  );
  check(
    survivingRequest.status === "accepted" &&
      survivingRequest.reviewed_by_user_id === agedDocComp.organizerId &&
      survivingRequest.review_note === "Sesuai",
    "DOC-R09  request row survives with verdict, reviewer and note intact (DEC-0122)",
  );

  const remainingFileRows = oneRow(
    await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM competition_document_request_files WHERE request_id = ${docRequest.id}
    `,
    "file row count",
  );
  check(remainingFileRows.n === 0, `DOC-R10  file rows are gone (got ${remainingFileRows.n})`);

  const controlKeys = await keysUnder(buildCompetitionObjectPrefix(recentDocComp.competitionId));
  check(
    controlKeys.length === 1,
    `DOC-R11  in-grace competition's object untouched (got ${controlKeys.length})`,
  );

  // ---- part B: unfinalized submission purge (SUBMISSION-T1) ------------------------------------

  console.log(
    `\n[submissions] purge reclaims abandoned uploads and never touches a finalized entry`,
  );

  const agedSubComp = await seedCompetition("retsub-aged", daysAgo(LONG_PAST_DAYS));
  const finalized = await seedRegistration(agedSubComp.competitionId);
  const draft = await seedRegistration(agedSubComp.competitionId);
  const finalizedRegistration = finalized.registrationId;
  const draftRegistration = draft.registrationId;

  const finalizedKey = await putObject(
    `${buildSubmissionRegistrationPrefix(agedSubComp.competitionId, finalizedRegistration)}${randomUUID()}`,
  );
  await client`
    INSERT INTO competition_submissions (registration_id, submitted_by_id, file_key, file_name, file_size_bytes, finalized_at)
    VALUES (${finalizedRegistration}, ${finalized.candidateId}, ${finalizedKey}, 'entry.pdf', ${pdfBytes().length}, ${daysAgo(LONG_PAST_DAYS + 1)})
  `;

  const draftKey = await putObject(
    `${buildSubmissionRegistrationPrefix(agedSubComp.competitionId, draftRegistration)}${randomUUID()}`,
  );
  await client`
    INSERT INTO competition_submissions (registration_id, submitted_by_id, file_key, file_name, file_size_bytes)
    VALUES (${draftRegistration}, ${draft.candidateId}, ${draftKey}, 'draft.pdf', ${pdfBytes().length})
  `;

  // An object under the competition prefix that no row references at all.
  const subOrphanKey = await putObject(
    `${buildSubmissionRegistrationPrefix(agedSubComp.competitionId, draftRegistration)}${randomUUID()}`,
  );

  const subsDue = await listCompetitionsDueForSubmissionPurge(90, db);
  check(
    subsDue.includes(agedSubComp.competitionId),
    "SUB-R01  aged competition is due for submission purge",
  );

  const subKeysBefore = await keysUnder(
    buildSubmissionCompetitionPrefix(agedSubComp.competitionId),
  );
  check(
    subKeysBefore.length === 3,
    `SUB-R02  3 objects before purge (got ${subKeysBefore.length})`,
  );

  const subOutcome = await purgeUnfinalizedSubmissionsForCompetition(agedSubComp.competitionId, db);
  check(
    subOutcome.finalizedKept === 1,
    `SUB-R03  1 finalized submission kept (got ${subOutcome.finalizedKept})`,
  );
  check(
    subOutcome.objectsDeleted === 2,
    `SUB-R04  2 objects deleted — the draft and the orphan (got ${subOutcome.objectsDeleted})`,
  );
  check(
    subOutcome.rowsDeleted === 1,
    `SUB-R05  1 unfinalized row deleted (got ${subOutcome.rowsDeleted})`,
  );

  const subKeysAfter = await keysUnder(buildSubmissionCompetitionPrefix(agedSubComp.competitionId));
  check(
    subKeysAfter.length === 1 && subKeysAfter[0] === finalizedKey,
    `SUB-R06  ONLY the finalized object remains in the bucket — read back from R2 (got ${subKeysAfter.length}: ${subKeysAfter.join(", ")})`,
  );
  check(!subKeysAfter.includes(subOrphanKey), "SUB-R07  the never-referenced object was reclaimed");

  const finalizedRow = oneRow(
    await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM competition_submissions WHERE registration_id = ${finalizedRegistration}
    `,
    "finalized row count",
  );
  check(finalizedRow.n === 1, "SUB-R08  finalized submission row survives at any age (DEC-0126)");

  const draftRow = oneRow(
    await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM competition_submissions WHERE registration_id = ${draftRegistration}
    `,
    "draft row count",
  );
  check(draftRow.n === 0, "SUB-R09  unfinalized row goes with its bytes (SUBMISSION-D4)");

  // ---- part C: recruiter-verification orphan sweep (RECRUITER-DOC-T1) --------------------------

  console.log(
    `\n[recruiter verification] orphan sweep deletes abandoned uploads and respects the presign window`,
  );

  const recruiterId = await seedUser("retrec");
  await client`UPDATE users SET recruiter_verified_at = now(), recruiter_verification_tier = 'minimal' WHERE id = ${recruiterId}`;

  const verificationSubmission = oneRow(
    await client<{ id: string }[]>`
      INSERT INTO recruiter_verification_submissions
        (user_id, full_name, mobile_number, status, first_submitted_at, submitted_at)
      VALUES (${recruiterId}, 'Retention Probe', '+628100000000', 'draft', now(), now())
      RETURNING id
    `,
    "recruiter verification submission",
  );

  const verifPrefix = `recruiter-verification/${recruiterId}/${verificationSubmission.id}/`;

  const referencedKey = await putObject(`${verifPrefix}${randomUUID()}`);
  await client`
    INSERT INTO recruiter_verification_documents
      (submission_id, r2_key, original_file_name, file_size_bytes, content_type)
    VALUES (${verificationSubmission.id}, ${referencedKey}, 'surat.pdf', ${pdfBytes().length}, 'application/pdf')
  `;
  const abandonedKey = await putObject(`${verifPrefix}${randomUUID()}`);

  // Age-guarded first: both objects were just created, so the abandoned one is still inside its
  // presign window and must NOT be taken away from a user who may still be uploading.
  await sweepOrphanedSubmissionObjects(
    recruiterId,
    verificationSubmission.id,
    { respectAge: true },
    db,
  );
  const afterAgeGuarded = await keysUnder(verifPrefix);
  check(
    afterAgeGuarded.length === 2,
    `REC-R01  age-guarded sweep keeps a fresh orphan — upload window still open (got ${afterAgeGuarded.length})`,
  );

  // Terminal sweep: the review has happened, nothing more is coming, so an unreferenced object is
  // unambiguously abandoned.
  await sweepOrphanedSubmissionObjects(
    recruiterId,
    verificationSubmission.id,
    { respectAge: false },
    db,
  );
  const afterTerminal = await keysUnder(verifPrefix);
  check(
    afterTerminal.length === 1 && afterTerminal[0] === referencedKey,
    `REC-R02  terminal sweep deletes ONLY the abandoned upload — read back from R2 (got ${afterTerminal.length}: ${afterTerminal.join(", ")})`,
  );
  check(
    !afterTerminal.includes(abandonedKey),
    "REC-R03  the abandoned upload is gone from the bucket",
  );

  const documentRows = oneRow(
    await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM recruiter_verification_documents WHERE submission_id = ${verificationSubmission.id}
    `,
    "recruiter document row count",
  );
  check(documentRows.n === 1, "REC-R04  the referenced document row is untouched by the sweep");

  // ---- cleanup -------------------------------------------------------------------------------

  for (const key of strayKeys) {
    try {
      await deleteObject(key);
    } catch {
      // Already deleted by the purge under test; that is the expected case for most of them.
    }
  }

  const allCompetitionIds = [
    agedDocComp.competitionId,
    recentDocComp.competitionId,
    nullEndDocComp.competitionId,
    agedSubComp.competitionId,
  ];
  await client`DELETE FROM competitions WHERE id = ANY(${allCompetitionIds})`;
  await client`DELETE FROM institutions WHERE id = ANY(${createdInstitutionIds})`;
  await client`DELETE FROM users WHERE id = ANY(${createdUserIds})`;
  console.log(
    `\nCleaned up ${createdUserIds.length} seeded users, ${createdInstitutionIds.length} institutions, and ${strayKeys.length} R2 objects.`,
  );

  await client.end({ timeout: 5 });
  finish(failureCount(), "R2 RETENTION");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
