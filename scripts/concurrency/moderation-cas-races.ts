import {
  assertReadCommitted,
  createChecker,
  describeOutcome,
  finish,
  oneRow,
  openPool,
  settleAll,
} from "./harness";
import { randomUUID } from "node:crypto";

const main = async (): Promise<void> => {
  const { client, db } = await openPool();
  const { suspendInstitution, reinstateInstitution } =
    await import("@/server/moderation/moderation-service");
  const { check, failureCount } = createChecker();
  const userIds: string[] = [];
  const institutionIds: string[] = [];
  let releaseActiveBarrier: () => void = () => {};
  const pendingRacers: Promise<unknown>[] = [];
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const seedUser = async (role: "candidate" | "platform_ops"): Promise<string> => {
    const id = randomUUID();
    userIds.push(id);
    await client`
      INSERT INTO users (id, email, username, role, candidate_verified_at)
      VALUES (${id}, ${`moderation_${id}@example.test`}, ${`moderation_${id}`}, ${role}, now())
    `;
    return id;
  };

  const waitForBlockedRacers = async (expected: number): Promise<boolean> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = oneRow(
        await client<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active'
          AND pid <> pg_backend_pid()
          AND (query LIKE '%institutions%' OR query LIKE '%pg_advisory_xact_lock%')
      `,
        "blocked backends",
      );
      if (row.n >= expected) return true;
      await delay(25);
    }
    return false;
  };

  const runRace = async (reinstate: boolean, iteration: number): Promise<void> => {
    const ownerId = await seedUser("candidate");
    const actorId = await seedUser("platform_ops");
    const institutionId = randomUUID();
    institutionIds.push(institutionId);
    await client`
      INSERT INTO institutions (id, display_name, slug, institution_type, suspended_at, suspension_reason)
      VALUES (${institutionId}, 'Moderation CAS fixture', ${`moderation-${institutionId}`}, 'company',
        ${reinstate ? new Date() : null}, ${reinstate ? "fixture" : null})
    `;
    await client`
      INSERT INTO institution_memberships (institution_id, user_id, membership_role, status)
      VALUES (${institutionId}, ${ownerId}, 'institution_owner', 'active')
    `;

    const service = reinstate ? reinstateInstitution : suspendInstitution;
    const name = reinstate ? "reinstateInstitution" : "suspendInstitution";
    const conflictCode = reinstate ? "institution_not_suspended" : "institution_already_suspended";
    const event = reinstate ? "institution.reinstated" : "institution.suspended";
    let releaseBarrier: () => void = () => {};
    let markBarrierReady: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    releaseActiveBarrier = releaseBarrier;
    const ready = new Promise<void>((resolve) => {
      markBarrierReady = resolve;
    });
    const racers: Promise<unknown>[] = [];
    const barrier = client.begin(async (tx) => {
      const lockClient = tx as unknown as typeof client;
      await lockClient`SELECT id FROM institutions WHERE id = ${institutionId} FOR UPDATE`;
      markBarrierReady();
      await released;
    });
    barrier.catch(markBarrierReady);

    let firstQueued = false;
    let bothQueued = false;
    try {
      await ready;
      const first = service(actorId, institutionId, "race reason", db);
      first.catch(() => {});
      racers.push(first);
      pendingRacers.push(first);
      firstQueued = await waitForBlockedRacers(1);
      const second = service(actorId, institutionId, "race reason", db);
      second.catch(() => {});
      racers.push(second);
      pendingRacers.push(second);
      bothQueued = await waitForBlockedRacers(2);
    } finally {
      releaseBarrier();
      await barrier;
    }
    const outcome = await settleAll(racers);
    const state = oneRow(
      await client<{ suspended_at: Date | null; suspension_reason: string | null }[]>`
      SELECT suspended_at, suspension_reason FROM institutions WHERE id = ${institutionId}
    `,
      "final institution",
    );
    const audits = await client<
      { actor_user_id: string; event_type: string; reason: string | null }[]
    >`
      SELECT actor_user_id, event_type, reason FROM platform_ops_audit_logs
      WHERE target_institution_id = ${institutionId}
    `;
    check(
      firstQueued &&
        bothQueued &&
        outcome.ok === 1 &&
        outcome.failCodes.length === 1 &&
        outcome.failCodes[0] === conflictCode &&
        outcome.failStatuses[0] === 409 &&
        outcome.other.length === 0 &&
        (state.suspended_at === null) === reinstate &&
        state.suspension_reason === (reinstate ? null : "race reason") &&
        audits.length === 1 &&
        audits[0]?.actor_user_id === actorId &&
        audits[0]?.event_type === event &&
        audits[0]?.reason === "race reason",
      `${name} iteration ${iteration}: ${describeOutcome(outcome)} barrier=${firstQueued && bothQueued} audit=${audits.length}` +
        ` [want: one success, ${conflictCode}(409), exactly one audit row naming the database actor]`,
    );
  };

  const cleanup = async (): Promise<void> => {
    releaseActiveBarrier();
    await Promise.allSettled(pendingRacers);
    await client`DELETE FROM platform_ops_audit_logs WHERE actor_user_id = ANY(${client.array(userIds)})`;
    await client`DELETE FROM institutions WHERE id = ANY(${client.array(institutionIds)})`;
    await client`DELETE FROM users WHERE id = ANY(${client.array(userIds)})`;
    const residue = oneRow(
      await client<{ n: number }[]>`
      SELECT (
        (SELECT count(*) FROM users WHERE id = ANY(${client.array(userIds)})) +
        (SELECT count(*) FROM institutions WHERE id = ANY(${client.array(institutionIds)})) +
        (SELECT count(*) FROM platform_ops_audit_logs WHERE actor_user_id = ANY(${client.array(userIds)})) +
        (SELECT count(*) FROM institution_memberships WHERE institution_id = ANY(${client.array(institutionIds)}))
      )::int AS n
    `,
      "fixture residue",
    );
    check(
      residue.n === 0,
      "moderation CAS fixture teardown leaves no users, institutions, memberships or audit rows",
    );
  };

  const onSignal = async (): Promise<void> => {
    try {
      await cleanup();
    } finally {
      await client.end();
    }
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await assertReadCommitted(client);
    for (let iteration = 0; iteration < 5; iteration += 1) {
      await runRace(false, iteration);
      await runRace(true, iteration);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    try {
      await cleanup();
    } finally {
      await client.end();
    }
  }
  finish(failureCount(), "MODERATION CAS");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
