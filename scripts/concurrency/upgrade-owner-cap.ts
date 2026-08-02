/**
 * UPGRADE-T1 — live two-connection proof that the per-owner institution cap holds when two
 * personal→full upgrades run concurrently.
 *
 * The race: an owner holding two full institutions (cap is 3) and two personal ones upgrades BOTH
 * personals at the same moment. Each upgrade counts the owner's OTHER full institutions and adds
 * one; under READ COMMITTED neither snapshot can see the other's uncommitted type flip, so without
 * serialization both read 2, both pass 2+1 <= 3, and the owner ends up with four full institutions.
 * The compare-and-set on the target row cannot fence this — the racers mutate DIFFERENT rows, so
 * there is no shared row to serialize on. Only acquireOwnerCapLock can.
 *
 * The two personal institutions are seeded with raw SQL: the service caps a recruiter at one
 * personal institution, but that cap is not what is under test here, and the cap under test needs
 * two upgradeable rows.
 *
 * Usage: node --import tsx scripts/concurrency/upgrade-owner-cap.ts
 * Exit code: 0 when every assertion holds; 1 on any cap breach or wrong error.
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
  const { upgradeInstitutionType, createInstitutionWorkspaceForUser } = await import(
    "@/server/institution-workspace/institution-service"
  );
  const { MAX_INSTITUTIONS_PER_RECRUITER } = await import(
    "@/server/institution-workspace/institution-core"
  );

  const { check, failureCount } = createChecker();
  const createdUserIds: string[] = [];

  // An elevated, recruiter-verified account: upgradeInstitutionType refuses anything less before it
  // ever reaches the cap count, so a lesser tier would make every racer fail for the wrong reason.
  const seedElevatedRecruiter = async (): Promise<string> => {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await client`
      INSERT INTO users (id, email, username, recruiter_verified_at, recruiter_verification_tier, email_verified)
      VALUES (${id}, ${`upgconc_${tag}@example.test`}, ${`upgconc_${tag}`}, now(), 'elevated', now())
    `;
    createdUserIds.push(id);
    return id;
  };

  const seedPersonalInstitution = async (userId: string, slug: string): Promise<string> => {
    const row = oneRow(await client<{ id: string }[]>`
      INSERT INTO institutions (display_name, slug, institution_type)
      VALUES (NULL, ${slug}, 'personal')
      RETURNING id
    `, "row");
    await client`
      INSERT INTO institution_memberships (institution_id, user_id, membership_role, status)
      VALUES (${row.id}, ${userId}, 'institution_owner', 'active')
    `;
    return row.id;
  };

  const countOwnedFull = async (userId: string): Promise<number> => {
    const rows = await client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM institution_memberships m
      JOIN institutions i ON i.id = m.institution_id
      WHERE m.user_id = ${userId}
        AND m.membership_role = 'institution_owner'
        AND m.status = 'active'
        AND i.institution_type IS DISTINCT FROM 'personal'
    `;
    return rows[0]?.n ?? 0;
  };

  const runSameOwnerRace = async (): Promise<void> => {
    console.log(
      `\n[upgrade] cap=${MAX_INSTITUTIONS_PER_RECRUITER}, ${ITERATIONS} iterations, two concurrent upgrades each`,
    );
    for (let i = 0; i < ITERATIONS; i += 1) {
      const userId = await seedElevatedRecruiter();
      const tag = userId.slice(0, 6);

      // Two full institutions leave exactly one free slot, so exactly one of the two upgrades below
      // may legally land.
      await createInstitutionWorkspaceForUser(
        userId,
        { displayName: `Upg Conc Full A ${i} ${tag}`, institutionType: "company" },
        db,
      );
      await createInstitutionWorkspaceForUser(
        userId,
        { displayName: `Upg Conc Full B ${i} ${tag}`, institutionType: "company" },
        db,
      );

      const personalOne = await seedPersonalInstitution(userId, `upgconc-p1-${i}-${tag}`);
      const personalTwo = await seedPersonalInstitution(userId, `upgconc-p2-${i}-${tag}`);

      // Distinct display names → distinct derived slugs, so nothing but the cap can stop a racer.
      const outcome = await race(
        () =>
          upgradeInstitutionType(userId, personalOne, "company", `Upg Conc Up One ${i} ${tag}`, null, db),
        () =>
          upgradeInstitutionType(userId, personalTwo, "foundation", `Upg Conc Up Two ${i} ${tag}`, null, db),
      );

      const finalFullCount = await countOwnedFull(userId);
      check(
        outcome.ok === 1 &&
          outcome.failCodes.length === 1 &&
          outcome.failCodes[0] === "institution_upgrade_limit_reached" &&
          outcome.failStatuses[0] === 409 &&
          outcome.other.length === 0 &&
          finalFullCount === MAX_INSTITUTIONS_PER_RECRUITER,
        `iter ${i}: ${describeOutcome(outcome)} owned_full=${finalFullCount}` +
          ` [want: ok=1 loser=institution_upgrade_limit_reached(409) owned_full=${MAX_INSTITUTIONS_PER_RECRUITER}]`,
      );
    }
  };

  // Without this, a lock that accidentally serialized ALL owners (a constant key, a global lock)
  // would still pass every assertion above.
  const runCrossOwnerControl = async (): Promise<void> => {
    console.log(`\n[cross-owner] two DIFFERENT owners upgrade simultaneously — both must succeed`);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const userOne = await seedElevatedRecruiter();
      const userTwo = await seedElevatedRecruiter();
      const tagOne = userOne.slice(0, 6);
      const tagTwo = userTwo.slice(0, 6);
      const personalOne = await seedPersonalInstitution(userOne, `upgconc-x1-${i}-${tagOne}`);
      const personalTwo = await seedPersonalInstitution(userTwo, `upgconc-x2-${i}-${tagTwo}`);

      const outcome = await race(
        () =>
          upgradeInstitutionType(userOne, personalOne, "company", `Upg Conc Cross One ${i} ${tagOne}`, null, db),
        () =>
          upgradeInstitutionType(userTwo, personalTwo, "company", `Upg Conc Cross Two ${i} ${tagTwo}`, null, db),
      );

      const countOne = await countOwnedFull(userOne);
      const countTwo = await countOwnedFull(userTwo);
      check(
        outcome.ok === 2 && outcome.failCodes.length === 0 && countOne === 1 && countTwo === 1,
        `iter ${i}: both succeed (${describeOutcome(outcome)}), each owns 1 full (u1=${countOne}, u2=${countTwo})`,
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
    await client`DELETE FROM institution_memberships WHERE user_id = ANY(${client.array(createdUserIds)})`;
    if (instIds.length > 0) {
      await client`DELETE FROM institutions WHERE id = ANY(${client.array(instIds)})`;
    }
    await client`DELETE FROM users WHERE id = ANY(${client.array(createdUserIds)})`;
    console.log(`\nCleaned up ${createdUserIds.length} seeded users and ${instIds.length} institutions.`);
  };

  try {
    await assertReadCommitted(client);
    await runSameOwnerRace();
    await runCrossOwnerControl();
  } finally {
    await cleanup();
    await client.end();
  }

  finish(failureCount(), "UPGRADE-T1");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
