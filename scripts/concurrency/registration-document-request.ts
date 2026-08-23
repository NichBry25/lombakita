/**
 * DOCVERIF-T3 — live proof of the two concurrency claims the participant-document-request batch
 * makes.
 *
 * Claim 1 (the per-registration lock): a participant holds at most one OPEN document request. The
 * predicate counts rows that do not exist yet, so under READ COMMITTED two concurrent creates each
 * take a snapshot blind to the other's insert; only the per-registration advisory lock serializes
 * them. The batch path must report a target that already has an open request as SKIPPED rather than
 * failing the call — one participant must not cost the rest of the batch theirs.
 *
 * Claim 2 (the sorted lock order): a batch locks its registration ids in SORTED order specifically
 * so two overlapping batches cannot deadlock. Nothing proved that ordering mattered. This drives two
 * batches over the same participants supplied in OPPOSITE order and asserts neither transaction dies
 * with SQLSTATE 40P01. Remove the `.sort()` and this arm is what catches it.
 *
 * Usage: node --import tsx scripts/concurrency/registration-document-request.ts
 * Exit code: 0 when every assertion holds; 1 on a duplicate open request, a failed batch, or a
 * deadlock.
 */

import {
  DEADLOCK_SQLSTATE,
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
// Enough targets that two batches locking in opposite order have a wide interleaving window. With
// two the deadlock is a coin flip; with six it is all but certain.
const OVERLAP_TARGETS = 6;

const main = async (): Promise<void> => {
  const { client, db } = await openPool();
  const { createDocumentRequest, createDocumentRequestsForRegistrations } =
    await import("@/server/registration-documents/registration-document-service");

  const { check, failureCount } = createChecker();
  const createdUserIds: string[] = [];
  const createdInstitutionIds: string[] = [];

  const requestInput = () => ({
    title: "Kartu pelajar",
    instructions: null,
    dueAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });

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

  type SeededCompetition = {
    institutionId: string;
    competitionId: string;
    organizerId: string;
    registrationIds: string[];
  };

  const seedCompetitionWithRegistrations = async (
    registrantCount: number,
  ): Promise<SeededCompetition> => {
    const organizerId = await seedUser("docreq_org");
    const tag = organizerId.slice(0, 8);

    const institution = oneRow(
      await client<{ id: string }[]>`
      INSERT INTO institutions (display_name, slug, institution_type)
      VALUES (${`Doc Req Conc ${tag}`}, ${`docreq-${tag}`}, 'company')
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
      INSERT INTO competitions (institution_id, created_by_user_id, slug, title, status)
      VALUES (${institution.id}, ${organizerId}, ${`docreq-comp-${tag}`}, ${`Doc Req Conc ${tag}`}, 'published')
      RETURNING id
    `,
      "competition",
    );

    const registrationIds: string[] = [];
    for (let index = 0; index < registrantCount; index += 1) {
      const candidateId = await seedUser("docreq_cand");
      const registration = oneRow(
        await client<{ id: string }[]>`
        INSERT INTO competition_registrations (competition_id, student_id)
        VALUES (${competition.id}, ${candidateId})
        RETURNING id
      `,
        "registration",
      );
      registrationIds.push(registration.id);
    }

    return {
      institutionId: institution.id,
      competitionId: competition.id,
      organizerId,
      registrationIds,
    };
  };

  const countOpenRequests = async (registrationId: string): Promise<number> => {
    const rows = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM competition_document_requests
      WHERE registration_id = ${registrationId} AND status IN ('requested', 'submitted')
    `;
    return rows[0]?.n ?? 0;
  };

  const countAllRequests = async (registrationId: string): Promise<number> => {
    const rows = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM competition_document_requests
      WHERE registration_id = ${registrationId}
    `;
    return rows[0]?.n ?? 0;
  };

  // The single-participant path converts an already-open target into a 409, because the organizer
  // named one person and is entitled to know the ask did not land.
  const runSingleTargetRace = async (): Promise<void> => {
    console.log(`\n[single] ${ITERATIONS} iterations, two concurrent requests per participant`);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seeded = await seedCompetitionWithRegistrations(1);
      const registrationId = oneRow(seeded.registrationIds, "seeded registration");

      const outcome = await race(
        () =>
          createDocumentRequest(
            seeded.institutionId,
            seeded.competitionId,
            seeded.organizerId,
            registrationId,
            requestInput(),
            db,
          ),
        () =>
          createDocumentRequest(
            seeded.institutionId,
            seeded.competitionId,
            seeded.organizerId,
            registrationId,
            requestInput(),
            db,
          ),
      );

      const open = await countOpenRequests(registrationId);
      const total = await countAllRequests(registrationId);
      check(
        outcome.ok === 1 &&
          outcome.failCodes.length === 1 &&
          outcome.failCodes[0] === "document_request_already_open" &&
          outcome.failStatuses[0] === 409 &&
          outcome.other.length === 0 &&
          open === 1 &&
          total === 1,
        `iter ${i}: ${describeOutcome(outcome)} open=${open} total=${total}` +
          ` [want: ok=1 loser=document_request_already_open(409) open=1 total=1]`,
      );
    }
  };

  // The batch path reports an already-open target as skipped and still completes, so the rest of the
  // batch lands. A throwing batch would be the failure this arm exists to catch.
  const runBatchOverlapRace = async (): Promise<void> => {
    console.log(`\n[batch] ${ITERATIONS} iterations, two identical concurrent batches`);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seeded = await seedCompetitionWithRegistrations(3);
      const targets = seeded.registrationIds;

      const runBatch = () =>
        createDocumentRequestsForRegistrations(
          seeded.institutionId,
          seeded.competitionId,
          seeded.organizerId,
          targets,
          requestInput(),
          db,
        );

      const outcome = await race(runBatch, runBatch);
      const results = outcome.values as Array<{
        created: Array<{ registrationId: string }>;
        skipped: Array<{ registrationId: string; reason: string }>;
      }>;

      const createdCount = results.reduce((sum, result) => sum + result.created.length, 0);
      const alreadyOpenSkips = results.reduce(
        (sum, result) =>
          sum + result.skipped.filter((skip) => skip.reason === "already_open").length,
        0,
      );
      const openCounts = await Promise.all(targets.map((id) => countOpenRequests(id)));
      const everyTargetHasExactlyOne = openCounts.every((count) => count === 1);

      check(
        outcome.ok === 2 &&
          outcome.other.length === 0 &&
          createdCount === targets.length &&
          alreadyOpenSkips === targets.length &&
          everyTargetHasExactlyOne,
        `iter ${i}: ${describeOutcome(outcome)} created=${createdCount} already_open_skips=${alreadyOpenSkips} open_per_target=[${openCounts.join(",")}]` +
          ` [want: ok=2 created=${targets.length} skips=${targets.length} open_per_target all 1]`,
      );
    }
  };

  // Two batches over the same participants, supplied in OPPOSITE order. The service sorts its
  // targets before locking, so both transactions take the locks in the same sequence and merely
  // queue. Without the sort they would each hold a lock the other needs.
  const runDeadlockProbe = async (): Promise<void> => {
    console.log(
      `\n[deadlock] ${ITERATIONS} iterations, two batches over ${OVERLAP_TARGETS} participants in opposite order`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seeded = await seedCompetitionWithRegistrations(OVERLAP_TARGETS);
      const ascending = [...seeded.registrationIds].sort();
      const descending = [...ascending].reverse();

      const outcome = await race(
        () =>
          createDocumentRequestsForRegistrations(
            seeded.institutionId,
            seeded.competitionId,
            seeded.organizerId,
            ascending,
            requestInput(),
            db,
          ),
        () =>
          createDocumentRequestsForRegistrations(
            seeded.institutionId,
            seeded.competitionId,
            seeded.organizerId,
            descending,
            requestInput(),
            db,
          ),
      );

      const deadlocked = outcome.sqlStates.includes(DEADLOCK_SQLSTATE);
      const openCounts = await Promise.all(ascending.map((id) => countOpenRequests(id)));
      const everyTargetHasExactlyOne = openCounts.every((count) => count === 1);

      check(
        !deadlocked && outcome.ok === 2 && outcome.other.length === 0 && everyTargetHasExactlyOne,
        `iter ${i}: ${describeOutcome(outcome)} deadlocked=${deadlocked} open_per_target=[${openCounts.join(",")}]` +
          ` [want: no deadlock, ok=2, one open request per target]`,
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
    await runSingleTargetRace();
    await runBatchOverlapRace();
    await runDeadlockProbe();
  } finally {
    await cleanup();
    await client.end();
  }

  finish(failureCount(), "DOCVERIF-T3");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
