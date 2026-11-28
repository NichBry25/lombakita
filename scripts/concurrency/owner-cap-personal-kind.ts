// OWNER-CAP-PERSONAL-KIND: live two-connection proof that the per-owner institution cap counts
// personal workspaces when both racers create one.
//
// The race: an owner holding two personal workspaces (the cap is 3) creates two more personal ones at
// the same moment. Each create counts the owner's workspaces under the owner lock. Without the lock,
// under READ COMMITTED neither snapshot sees the other's uncommitted insert, both read 2, and the
// owner ends with four. A count that left the personal kind out would let both through as well.
//
// Every workspace is created through createInstitutionWorkspaceForUser. Only the accounts are
// inserted directly, as the other scripts here insert them. Fixtures are removed on exit and on
// SIGINT or SIGTERM, and the run fails when any of them survives.
//
// Usage: node --import tsx scripts/concurrency/owner-cap-personal-kind.ts
// Exit code: 0 when every assertion holds, 1 on any cap breach, wrong error or surviving fixture row.

import {
  assertReadCommitted,
  createChecker,
  describeOutcome,
  finish,
  oneRow,
  openPool,
  race,
  resolveIterations,
} from "./harness";
import { randomUUID } from "crypto";

const ITERATIONS = resolveIterations(5);

const main = async (): Promise<void> => {
  const { client, db } = await openPool();
  const { createInstitutionWorkspaceForUser } =
    await import("@/server/institution-workspace/institution-service");
  const { MAX_INSTITUTIONS_PER_RECRUITER } =
    await import("@/server/institution-workspace/institution-core");

  const { check, failureCount } = createChecker();
  const createdUserIds: string[] = [];
  const removedInstitutionIds: string[] = [];

  // The cap is a service-layer count over memberships, so the account needs no host role.
  const seedOwner = async (): Promise<string> => {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await client`
      INSERT INTO users (id, email, username, candidate_verified_at, email_verified)
      VALUES (${id}, ${`pkind_${tag}@example.test`}, ${`pkind_${tag}`}, now(), now())
    `;
    createdUserIds.push(id);
    return id;
  };

  // Distinct display names give distinct slugs, so only the cap can stop a racer.
  const createPersonal = (userId: string, label: string) =>
    createInstitutionWorkspaceForUser(
      userId,
      { displayName: `Pkind ${label} ${userId.slice(0, 8)}`, institutionType: "personal" },
      db,
    );

  const countOwned = async (userId: string): Promise<number> => {
    const rows = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM institution_memberships
      WHERE user_id = ${userId}
        AND membership_role = 'institution_owner'
        AND status = 'active'
    `;
    return rows[0]?.n ?? 0;
  };

  const runSameOwnerRace = async (): Promise<void> => {
    console.log(
      `\n[same owner] cap=${MAX_INSTITUTIONS_PER_RECRUITER}, ${ITERATIONS} iterations, two personal workspaces held, two personal creates at once`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const userId = await seedOwner();
      await createPersonal(userId, `A${i}`);
      await createPersonal(userId, `B${i}`);

      const outcome = await race(
        () => createPersonal(userId, `C${i}`),
        () => createPersonal(userId, `D${i}`),
      );

      const owned = await countOwned(userId);
      check(
        outcome.ok === 1 &&
          outcome.failCodes.length === 1 &&
          outcome.failCodes[0] === "recruiter_institution_limit_reached" &&
          outcome.failStatuses[0] === 409 &&
          outcome.other.length === 0 &&
          owned === MAX_INSTITUTIONS_PER_RECRUITER,
        `iter ${i}: ${describeOutcome(outcome)} owned=${owned}` +
          ` [want: ok=1 loser=recruiter_institution_limit_reached(409) owned=${MAX_INSTITUTIONS_PER_RECRUITER}]`,
      );
    }
  };

  // Without this control, a lock that serialized every owner (a constant key, a global lock) would
  // still pass the race above.
  const runCrossOwnerControl = async (): Promise<void> => {
    console.log(
      `\n[cross-owner] two DIFFERENT owners each holding two personal workspaces create one more at once, both must succeed`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const userOne = await seedOwner();
      const userTwo = await seedOwner();
      await createPersonal(userOne, `A${i}`);
      await createPersonal(userOne, `B${i}`);
      await createPersonal(userTwo, `A${i}`);
      await createPersonal(userTwo, `B${i}`);

      const outcome = await race(
        () => createPersonal(userOne, `C${i}`),
        () => createPersonal(userTwo, `C${i}`),
      );

      const ownedOne = await countOwned(userOne);
      const ownedTwo = await countOwned(userTwo);
      check(
        outcome.ok === 2 &&
          outcome.failCodes.length === 0 &&
          outcome.other.length === 0 &&
          ownedOne === MAX_INSTITUTIONS_PER_RECRUITER &&
          ownedTwo === MAX_INSTITUTIONS_PER_RECRUITER,
        `iter ${i}: both succeed (${describeOutcome(outcome)}), each owns ${MAX_INSTITUTIONS_PER_RECRUITER} (u1=${ownedOne}, u2=${ownedTwo})`,
      );
    }
  };

  const cleanup = async (): Promise<void> => {
    if (createdUserIds.length === 0) return;
    const instRows = await client<{ institution_id: string }[]>`
      SELECT DISTINCT institution_id
      FROM institution_memberships
      WHERE user_id = ANY(${client.array(createdUserIds)})
    `;
    const instIds = instRows.map((row) => row.institution_id);
    removedInstitutionIds.push(...instIds);
    await client`DELETE FROM institution_memberships WHERE user_id = ANY(${client.array(createdUserIds)})`;
    if (instIds.length > 0) {
      await client`DELETE FROM institutions WHERE id = ANY(${client.array(instIds)})`;
    }
    await client`DELETE FROM users WHERE id = ANY(${client.array(createdUserIds)})`;
    console.log(
      `\nCleaned up ${createdUserIds.length} seeded users and ${instIds.length} institutions.`,
    );
  };

  // What the cleanup left, counted by the ids this run created. A delete that removed less than it
  // should then fails the run instead of leaving rows on the database unannounced.
  const assertFixturesRemoved = async (): Promise<void> => {
    if (createdUserIds.length === 0) return;

    const survivors = oneRow(
      await client<{ users: number; institutions: number; memberships: number }[]>`
        SELECT
          (SELECT count(*) FROM users WHERE id = ANY(${client.array(createdUserIds)}))::int AS users,
          (SELECT count(*) FROM institutions WHERE id = ANY(${client.array(removedInstitutionIds)}))::int AS institutions,
          (SELECT count(*) FROM institution_memberships WHERE user_id = ANY(${client.array(createdUserIds)}))::int AS memberships
      `,
      "survivors",
    );
    const survivorCounts = Object.entries(survivors);
    const total = survivorCounts.reduce((sum, [, count]) => sum + count, 0);
    const listed = survivorCounts.map(([table, count]) => `${table} ${count}`).join(", ");
    check(
      total === 0,
      `every fixture row this run seeded is removed on exit${total === 0 ? "" : `: ${total} survived (${listed})`}`,
    );
  };

  // finally does not run on a signal, so an interrupted run would leave its rows behind. SIGINT and
  // SIGTERM are caught here. SIGKILL cannot be.
  const handleSignal = (signal: NodeJS.Signals, exitCode: number): void => {
    process.once(signal, () => {
      console.log(`\n${signal} received, removing fixtures before exit`);
      void cleanup()
        .catch((error) => console.error("cleanup after signal failed:", error))
        .finally(() => {
          void client.end().finally(() => process.exit(exitCode));
        });
    });
  };

  handleSignal("SIGINT", 130);
  handleSignal("SIGTERM", 143);

  try {
    await assertReadCommitted(client);
    await runSameOwnerRace();
    await runCrossOwnerControl();
  } finally {
    try {
      await cleanup();
    } finally {
      await assertFixturesRemoved();
      await client.end();
    }
  }

  finish(failureCount(), "OWNER-CAP-PERSONAL-KIND");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
