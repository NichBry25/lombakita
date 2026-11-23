// @vitest-environment node
//
// Nobody writes, publishes or unpublishes a result for an entry they or their team hold.
//
// Every suite is rollback-wrapped and seeds through the product's own services: registrations, teams,
// team memberships and result rows are written by createIndividualRegistration, createTeam,
// inviteTeamMember, acceptTeamInvitationForUser, submitTeamRegistration, cancelTeamRegistration,
// removeTeamMember, upsertResultDraft and publishResult. Only users, the institution, its owner and
// staff memberships and the competition are inserted directly.
//
// A refusal test reads the database first and the refusal second. A guard that runs after the
// writer's commit still refuses, so only the rows can tell a guard in place from a guard moved.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionResults,
  competitions,
  institutionAuditLogs,
  institutionMemberships,
  institutions,
  teamMemberships,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { createIndividualRegistration } from "@/server/registrations/registration-service";
import {
  acceptTeamInvitationForUser,
  createTeam,
  inviteTeamMember,
  removeTeamMember,
} from "@/server/teams/team-service";
import {
  cancelTeamRegistration,
  submitTeamRegistration,
} from "@/server/teams/team-registration-service";
import {
  ResultError,
  publishResult,
  unpublishResult,
  upsertResultDraft,
} from "@/server/participants/result-service";

const enqueueSpies = vi.hoisted(() => ({
  enqueueRegistrationConfirmed: vi.fn(),
  enqueueRegistrationCancelled: vi.fn(),
  enqueueTeamInvitationDispatch: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/async/enqueue")>()),
  ...enqueueSpies,
}));

beforeEach(() => {
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

const MARKER = "ownres";
const DAY_MS = 86_400_000;
const POST_STATE = "own-result-post-state";

const client = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const inRollback = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("no database");
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

const daysFromNow = (days: number): Date => new Date(Date.now() + days * DAY_MS);

type Refusal = { code: string; status: number };

const OWN_RESULT_REFUSAL: Refusal = { code: "result_own_place", status: 403 };

const refusalOf = async (work: Promise<unknown>): Promise<Refusal | null> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof ResultError) return { code: error.code, status: error.httpStatus };
    throw error;
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// Fixtures that are not places: users, the institution with its owner, and the competition.

type Candidate = { id: string; username: string };

const seedCandidate = async (tx: Tx, label: string): Promise<Candidate> => {
  const suffix = uniqueSuffix();
  const username = `${MARKER}_${label}_${suffix}`;
  const [row] = await tx
    .insert(users)
    .values({
      email: `${MARKER}-${label}-${suffix}@example.test`,
      username,
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return { id: row!.id, username };
};

const seedStaffMembership = async (
  tx: Tx,
  institutionId: string,
  userId: string,
  membershipRole: "institution_owner" | "institution_staff",
): Promise<string> => {
  const [row] = await tx
    .insert(institutionMemberships)
    .values({ institutionId, userId, membershipRole, status: "active" })
    .returning({ id: institutionMemberships.id });
  return row!.id;
};

type World = {
  institutionId: string;
  ownerId: string;
  ownerMembershipId: string;
  competitionId: string;
};

const seedWorld = async (tx: Tx): Promise<World> => {
  const suffix = uniqueSuffix();
  const owner = await seedCandidate(tx, "own");

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `${MARKER}-${suffix}`,
      institutionType: "company",
      displayName: `Own result ${suffix}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });
  const institutionId = institution!.id;

  const ownerMembershipId = await seedStaffMembership(
    tx,
    institutionId,
    owner.id,
    "institution_owner",
  );

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId,
      slug: `${MARKER}-c-${suffix}`,
      title: "Lomba uji",
      status: "published",
      mode: "both",
      minTeamSize: 2,
      maxTeamSize: 4,
      registrationStartAt: daysFromNow(-1),
      registrationEndAt: daysFromNow(30),
      eventStartAt: daysFromNow(60),
      eventEndAt: daysFromNow(61),
      allowCancellation: true,
      cancellationCutoffDays: 1,
    })
    .returning({ id: competitions.id });

  return { institutionId, ownerId: owner.id, ownerMembershipId, competitionId: competition!.id };
};

// ---------------------------------------------------------------------------------------------
// Entries, each built through the product so that only one clause of the guard can refuse.

type Entry = { actorId: string; registrationId: string };

const startTeam = async (tx: Tx, world: World, captain: Candidate): Promise<string> => {
  const team = await createTeam(
    captain.id,
    world.competitionId,
    { name: `Tim ${uniqueSuffix()}` },
    tx as never,
  );
  return team.id;
};

const joinTeam = async (
  tx: Tx,
  captain: Candidate,
  teamId: string,
  member: Candidate,
): Promise<void> => {
  const invitation = await inviteTeamMember(
    captain.id,
    teamId,
    { invitedIdentifier: member.username },
    tx as never,
  );
  await acceptTeamInvitationForUser(invitation.id, member.id, tx as never);
};

const submitTeam = async (
  tx: Tx,
  world: World,
  captain: Candidate,
  teamId: string,
): Promise<string> => {
  const submitted = await submitTeamRegistration(
    captain.id,
    world.competitionId,
    teamId,
    tx as never,
  );
  const captainRow = submitted.registrations.find((row) => row.studentId === captain.id);
  return captainRow!.id;
};

const cancelTeam = async (
  tx: Tx,
  world: World,
  captain: Candidate,
  teamId: string,
): Promise<void> => {
  await cancelTeamRegistration(captain.id, world.competitionId, teamId, "uji", tx as never);
};

const rowsOfUserInCompetition = async (tx: Tx, world: World, userId: string) => {
  const rows = await tx
    .select({
      id: schema.competitionRegistrations.id,
      status: schema.competitionRegistrations.status,
      teamId: schema.competitionRegistrations.teamId,
    })
    .from(schema.competitionRegistrations)
    .where(
      and(
        eq(schema.competitionRegistrations.competitionId, world.competitionId),
        eq(schema.competitionRegistrations.studentId, userId),
      ),
    );
  return rows;
};

const membershipStatusesOfUser = async (tx: Tx, teamId: string, userId: string) => {
  const rows = await tx
    .select({ status: teamMemberships.status })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)));
  return rows.map((row) => row.status);
};

// Clause (a): the actor is the candidate of the target registration, and is on no team.
const buildOwnIndividualEntry = async (tx: Tx, world: World): Promise<Entry> => {
  const actor = await seedCandidate(tx, "solo");
  const registration = await createIndividualRegistration(
    actor.id,
    world.competitionId,
    tx as never,
  );

  const rows = await rowsOfUserInCompetition(tx, world, actor.id);
  expect(
    rows.map((row) => row.teamId),
    "seed: the actor is on no team",
  ).toEqual([null]);

  return { actorId: actor.id, registrationId: registration.id };
};

// Clause (b): the actor is an active member of the team and has no registration row under it,
// because they joined after the captain cancelled. The target is the captain's cancelled row.
const buildActiveMemberWithoutRowEntry = async (tx: Tx, world: World): Promise<Entry> => {
  const captain = await seedCandidate(tx, "cap");
  const mate = await seedCandidate(tx, "mate");
  const lateMember = await seedCandidate(tx, "late");

  const teamId = await startTeam(tx, world, captain);
  await joinTeam(tx, captain, teamId, mate);
  const captainRegistrationId = await submitTeam(tx, world, captain, teamId);
  await cancelTeam(tx, world, captain, teamId);
  await joinTeam(tx, captain, teamId, lateMember);

  const lateRows = await rowsOfUserInCompetition(tx, world, lateMember.id);
  expect(lateRows, "seed: the late member has no registration row").toEqual([]);
  const lateMembership = await membershipStatusesOfUser(tx, teamId, lateMember.id);
  expect(lateMembership, "seed: the late member is active on the team").toEqual(["active"]);

  return { actorId: lateMember.id, registrationId: captainRegistrationId };
};

// Clause (c): the actor was removed from the team, so they are no longer an active member, but their
// cancelled row still sits under the team. The target is the captain's new row.
const buildFormerMemberEntry = async (tx: Tx, world: World): Promise<Entry> => {
  const captain = await seedCandidate(tx, "cap");
  const former = await seedCandidate(tx, "former");
  const mate = await seedCandidate(tx, "mate");

  const teamId = await startTeam(tx, world, captain);
  await joinTeam(tx, captain, teamId, former);
  await joinTeam(tx, captain, teamId, mate);
  await submitTeam(tx, world, captain, teamId);
  await cancelTeam(tx, world, captain, teamId);

  const [formerMembership] = await tx
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, former.id)));
  await removeTeamMember(captain.id, teamId, formerMembership!.id, tx as never);
  const captainRegistrationId = await submitTeam(tx, world, captain, teamId);

  const formerRows = await rowsOfUserInCompetition(tx, world, former.id);
  expect(
    formerRows.map((row) => ({ status: row.status, teamId: row.teamId })),
    "seed: the former member keeps one cancelled row under the team",
  ).toEqual([{ status: "cancelled", teamId }]);
  const formerMembershipStatuses = await membershipStatusesOfUser(tx, teamId, former.id);
  expect(formerMembershipStatuses, "seed: the former member is no longer active").toEqual([
    "removed",
  ]);

  return { actorId: former.id, registrationId: captainRegistrationId };
};

// ---------------------------------------------------------------------------------------------
// The three writers, each preceded by the rows another staff member leaves for it to act on.

type Actor = { actorUserId: string; actorMembershipId: string };

const ownerActor = (world: World): Actor => ({
  actorUserId: world.ownerId,
  actorMembershipId: world.ownerMembershipId,
});

const writeDraftAsOwner = (tx: Tx, world: World, registrationId: string) =>
  upsertResultDraft(
    world.institutionId,
    world.competitionId,
    registrationId,
    world.ownerId,
    { resultLabel: "Juara 1", resultNotes: "Catatan awal" },
    tx as never,
  );

const publishAsOwner = (tx: Tx, world: World, registrationId: string) =>
  publishResult(
    world.institutionId,
    world.competitionId,
    registrationId,
    world.ownerId,
    world.ownerMembershipId,
    tx as never,
  );

type Writer = {
  name: string;
  prepareRows: (tx: Tx, world: World, registrationId: string) => Promise<void>;
  attempt: (tx: Tx, world: World, registrationId: string, actor: Actor) => Promise<unknown>;
};

const draftWriter: Writer = {
  name: "upsertResultDraft",
  prepareRows: async (tx, world, registrationId) => {
    await writeDraftAsOwner(tx, world, registrationId);
  },
  attempt: (tx, world, registrationId, actor) =>
    upsertResultDraft(
      world.institutionId,
      world.competitionId,
      registrationId,
      actor.actorUserId,
      { resultLabel: "Dicoba lagi", resultNotes: "Diubah" },
      tx as never,
    ),
};

const publishWriter: Writer = {
  name: "publishResult",
  prepareRows: async (tx, world, registrationId) => {
    await writeDraftAsOwner(tx, world, registrationId);
  },
  attempt: (tx, world, registrationId, actor) =>
    publishResult(
      world.institutionId,
      world.competitionId,
      registrationId,
      actor.actorUserId,
      actor.actorMembershipId,
      tx as never,
    ),
};

const unpublishWriter: Writer = {
  name: "unpublishResult",
  prepareRows: async (tx, world, registrationId) => {
    await writeDraftAsOwner(tx, world, registrationId);
    await publishAsOwner(tx, world, registrationId);
  },
  attempt: (tx, world, registrationId, actor) =>
    unpublishResult(
      world.institutionId,
      world.competitionId,
      registrationId,
      actor.actorUserId,
      actor.actorMembershipId,
      tx as never,
    ),
};

const WRITERS = [draftWriter, publishWriter, unpublishWriter];

// ---------------------------------------------------------------------------------------------
// What a refused write must leave untouched.

type ResultRowSnapshot = {
  registrationId: string;
  resultStatus: string;
  resultLabel: string | null;
  resultNotes: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
};

const snapshotResultRows = async (tx: Tx, world: World): Promise<ResultRowSnapshot[]> => {
  const rows = await tx
    .select({
      registrationId: competitionResults.registrationId,
      resultStatus: competitionResults.resultStatus,
      resultLabel: competitionResults.resultLabel,
      resultNotes: competitionResults.resultNotes,
      publishedAt: competitionResults.publishedAt,
      updatedAt: competitionResults.updatedAt,
    })
    .from(competitionResults)
    .where(eq(competitionResults.competitionId, world.competitionId));
  return rows.sort((a, b) => a.registrationId.localeCompare(b.registrationId));
};

const countAuditRows = async (
  tx: Tx,
  world: World,
  action: "result_published" | "result_unpublished",
): Promise<number> => {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(institutionAuditLogs)
    .where(
      and(
        eq(institutionAuditLogs.institutionId, world.institutionId),
        eq(institutionAuditLogs.action, action),
      ),
    );
  return row!.count;
};

const readPostState = async (tx: Tx, world: World) => ({
  resultRows: await snapshotResultRows(tx, world),
  publishedAuditRows: await countAuditRows(tx, world, "result_published"),
  unpublishedAuditRows: await countAuditRows(tx, world, "result_unpublished"),
});

// ---------------------------------------------------------------------------------------------

const CLAUSES = [
  { clause: "(a) the actor's own registration", build: buildOwnIndividualEntry },
  { clause: "(b) an active member of the team", build: buildActiveMemberWithoutRowEntry },
  {
    clause: "(c) a cancelled row of a former member under the team",
    build: buildFormerMemberEntry,
  },
];

describe.skipIf(skipWithoutDatabase)(
  "a result write on the actor's own entry (real database)",
  () => {
    describe.each(CLAUSES)("refuses $clause", ({ build }) => {
      it.each(WRITERS)("for $name", async (writer) => {
        await inRollback(async (tx) => {
          const world = await seedWorld(tx);
          const entry = await build(tx, world);
          await writer.prepareRows(tx, world, entry.registrationId);
          const actorMembershipId = await seedStaffMembership(
            tx,
            world.institutionId,
            entry.actorId,
            "institution_staff",
          );
          const before = await readPostState(tx, world);

          const refusal = await refusalOf(
            writer.attempt(tx, world, entry.registrationId, {
              actorUserId: entry.actorId,
              actorMembershipId,
            }),
          );

          const after = await readPostState(tx, world);
          expect(after, POST_STATE).toEqual(before);
          expect(refusal).toEqual(OWN_RESULT_REFUSAL);
        });
      });
    });

    describe("allows an actor who holds none of the entries on the team", () => {
      it("for upsertResultDraft", async () => {
        await inRollback(async (tx) => {
          const world = await seedWorld(tx);
          const entry = await buildFormerMemberEntry(tx, world);
          await draftWriter.prepareRows(tx, world, entry.registrationId);

          await draftWriter.attempt(tx, world, entry.registrationId, ownerActor(world));

          const rows = await snapshotResultRows(tx, world);
          expect(rows.map((row) => ({ status: row.resultStatus, label: row.resultLabel }))).toEqual(
            [{ status: "draft", label: "Dicoba lagi" }],
          );
        });
      });

      it("for publishResult", async () => {
        await inRollback(async (tx) => {
          const world = await seedWorld(tx);
          const entry = await buildFormerMemberEntry(tx, world);
          await publishWriter.prepareRows(tx, world, entry.registrationId);

          await publishWriter.attempt(tx, world, entry.registrationId, ownerActor(world));

          const rows = await snapshotResultRows(tx, world);
          expect(rows.length).toBeGreaterThan(1);
          expect(rows.every((row) => row.resultStatus === "published")).toBe(true);
          expect(await countAuditRows(tx, world, "result_published")).toBe(1);
        });
      });

      it("for unpublishResult", async () => {
        await inRollback(async (tx) => {
          const world = await seedWorld(tx);
          const entry = await buildFormerMemberEntry(tx, world);
          await unpublishWriter.prepareRows(tx, world, entry.registrationId);

          await unpublishWriter.attempt(tx, world, entry.registrationId, ownerActor(world));

          const rows = await snapshotResultRows(tx, world);
          expect(rows.length).toBeGreaterThan(1);
          expect(rows.every((row) => row.resultStatus === "draft")).toBe(true);
          expect(await countAuditRows(tx, world, "result_unpublished")).toBe(1);
        });
      });
    });
  },
);
