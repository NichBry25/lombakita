// @vitest-environment node
//
// Nobody who holds an entry in a competition writes, publishes or unpublishes a result of another
// entrant of that competition.
//
// Every suite is rollback-wrapped and seeds through the product's own services: registrations, teams,
// team memberships and result rows are written by createIndividualRegistration, cancelRegistration,
// createTeam, inviteTeamMember, acceptTeamInvitationForUser, submitTeamRegistration,
// cancelTeamRegistration, removeTeamMember, upsertResultDraft and publishResult. Users, the
// institution, its owner and staff memberships and the competitions are inserted directly, and so is
// the one team membership of the actor that no product path leaves without a registration row of
// their own.
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
  teams,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import {
  cancelRegistration,
  createIndividualRegistration,
} from "@/server/registrations/registration-service";
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

const MARKER = "entres";
const DAY_MS = 86_400_000;
const POST_STATE = "entrant-result-post-state";

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

const endTheEvent = async (tx: Tx, competitionId: string): Promise<void> => {
  await tx
    .update(competitions)
    .set({
      registrationStartAt: daysFromNow(-10),
      registrationEndAt: daysFromNow(-5),
      eventStartAt: daysFromNow(-3),
      eventEndAt: daysFromNow(-1),
    })
    .where(eq(competitions.id, competitionId));
};

type Refusal = { code: string; status: number };

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
// Fixtures that are not places: users, the institution with its owner, and the competitions.

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

const seedCompetition = async (tx: Tx, institutionId: string, label: string): Promise<string> => {
  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId,
      slug: `${MARKER}-${label}-${uniqueSuffix()}`,
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
  return competition!.id;
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
      displayName: `Entrant result ${suffix}`,
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
  const competitionId = await seedCompetition(tx, institutionId, "c");

  return { institutionId, ownerId: owner.id, ownerMembershipId, competitionId };
};

// ---------------------------------------------------------------------------------------------
// Entries, each built through the product so that only one clause of the guard can refuse.

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

const rowsOfUserInCompetition = async (tx: Tx, competitionId: string, userId: string) => {
  const rows = await tx
    .select({
      id: schema.competitionRegistrations.id,
      status: schema.competitionRegistrations.status,
      teamId: schema.competitionRegistrations.teamId,
    })
    .from(schema.competitionRegistrations)
    .where(
      and(
        eq(schema.competitionRegistrations.competitionId, competitionId),
        eq(schema.competitionRegistrations.studentId, userId),
      ),
    );
  return rows;
};

const rowsOfTeam = async (tx: Tx, teamId: string) => {
  const rows = await tx
    .select({ status: schema.competitionRegistrations.status })
    .from(schema.competitionRegistrations)
    .where(eq(schema.competitionRegistrations.teamId, teamId));
  return rows.map((row) => row.status);
};

const membershipStatusesOfUser = async (tx: Tx, teamId: string, userId: string) => {
  const rows = await tx
    .select({ status: teamMemberships.status })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)));
  return rows.map((row) => row.status);
};

const teamMembershipsInCompetition = async (tx: Tx, competitionId: string, userId: string) => {
  const rows = await tx
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
    .where(and(eq(teamMemberships.userId, userId), eq(teams.competitionId, competitionId)));
  return rows;
};

// The entrant whose registration a write is aimed at. They are on no team, so no clause of the
// own-entry guard can refuse a target of theirs for an actor who is not them.
const buildTargetEntrant = async (tx: Tx, world: World): Promise<string> => {
  const target = await seedCandidate(tx, "target");
  const registration = await createIndividualRegistration(
    target.id,
    world.competitionId,
    tx as never,
  );
  return registration.id;
};

// Entrant through their own registration, on no team.
const buildActorWithOwnIndividualEntry = async (tx: Tx, world: World): Promise<string> => {
  const actor = await seedCandidate(tx, "solo");
  await createIndividualRegistration(actor.id, world.competitionId, tx as never);

  const rows = await rowsOfUserInCompetition(tx, world.competitionId, actor.id);
  expect(
    rows.map((row) => ({ status: row.status, teamId: row.teamId })),
    "seed: the actor holds one live registration of their own, on no team",
  ).toEqual([{ status: "confirmed", teamId: null }]);

  return actor.id;
};

// Entrant through the team clause alone: an active member of a registered team with no registration
// row of their own. The membership is inserted directly because every product path gives an active
// member of a registered team a row of their own (open debt FINANCE-D76).
const buildActorWithTeamPlaceAndNoRow = async (tx: Tx, world: World): Promise<string> => {
  const captain = await seedCandidate(tx, "cap");
  const mate = await seedCandidate(tx, "mate");
  const actor = await seedCandidate(tx, "orphan");

  const teamId = await startTeam(tx, world, captain);
  await joinTeam(tx, captain, teamId, mate);
  await submitTeam(tx, world, captain, teamId);
  await tx
    .insert(teamMemberships)
    .values({ teamId, userId: actor.id, role: "member", status: "active" });

  const actorRows = await rowsOfUserInCompetition(tx, world.competitionId, actor.id);
  expect(actorRows, "seed: the actor has no registration row").toEqual([]);
  const actorMembership = await membershipStatusesOfUser(tx, teamId, actor.id);
  expect(actorMembership, "seed: the actor is active on the team").toEqual(["active"]);
  const teamRows = await rowsOfTeam(tx, teamId);
  expect(
    teamRows.every((status) => status !== "cancelled"),
    "seed: the team holds only live registrations",
  ).toBe(true);

  return actor.id;
};

// Withdrawn through the individual cancel: the actor's only row is cancelled.
const buildActorWithCancelledOwnEntry = async (tx: Tx, world: World): Promise<string> => {
  const actor = await seedCandidate(tx, "left");
  const registration = await createIndividualRegistration(
    actor.id,
    world.competitionId,
    tx as never,
  );
  await cancelRegistration(actor.id, world.competitionId, registration.id, "uji", tx as never);

  const rows = await rowsOfUserInCompetition(tx, world.competitionId, actor.id);
  expect(
    rows.map((row) => ({ status: row.status, teamId: row.teamId })),
    "seed: the actor's only row is cancelled",
  ).toEqual([{ status: "cancelled", teamId: null }]);

  return actor.id;
};

// Withdrawn through the captain: the actor is still an active member, but every row of the team is
// cancelled and the team is back to forming.
const buildActorOnTeamWhoseRegistrationWasCancelled = async (
  tx: Tx,
  world: World,
): Promise<string> => {
  const captain = await seedCandidate(tx, "cap");
  const mate = await seedCandidate(tx, "mate");
  const actor = await seedCandidate(tx, "member");

  const teamId = await startTeam(tx, world, captain);
  await joinTeam(tx, captain, teamId, mate);
  await joinTeam(tx, captain, teamId, actor);
  await submitTeam(tx, world, captain, teamId);
  await cancelTeam(tx, world, captain, teamId);

  const actorMembership = await membershipStatusesOfUser(tx, teamId, actor.id);
  expect(actorMembership, "seed: the actor is still active on the team").toEqual(["active"]);
  const teamRows = await rowsOfTeam(tx, teamId);
  expect(teamRows.length, "seed: the team has rows").toBeGreaterThan(0);
  expect(
    teamRows.every((status) => status === "cancelled"),
    "seed: every row of the team is cancelled",
  ).toBe(true);

  return actor.id;
};

// Removed from a team that registered again afterwards: the actor's cancelled row still sits under
// the team, and the team still holds a live row.
const buildFormerMemberOfRegisteredTeam = async (tx: Tx, world: World): Promise<string> => {
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
  await submitTeam(tx, world, captain, teamId);

  const formerRows = await rowsOfUserInCompetition(tx, world.competitionId, former.id);
  expect(
    formerRows.map((row) => ({ status: row.status, teamId: row.teamId })),
    "seed: the former member keeps one cancelled row under the team",
  ).toEqual([{ status: "cancelled", teamId }]);
  const formerMembershipStatuses = await membershipStatusesOfUser(tx, teamId, former.id);
  expect(formerMembershipStatuses, "seed: the former member is no longer active").toEqual([
    "removed",
  ]);
  const teamRows = await rowsOfTeam(tx, teamId);
  expect(
    teamRows.some((status) => status !== "cancelled"),
    "seed: the team still holds a live row",
  ).toBe(true);

  return former.id;
};

// Entries in two other competitions of the institution, and none in the one the write is in.
const buildActorWithEntriesInOtherCompetitionsOnly = async (
  tx: Tx,
  world: World,
): Promise<string> => {
  const actor = await seedCandidate(tx, "away");
  const secondCompetitionId = await seedCompetition(tx, world.institutionId, "second");
  const thirdCompetitionId = await seedCompetition(tx, world.institutionId, "third");
  const thirdWorld: World = { ...world, competitionId: thirdCompetitionId };

  await createIndividualRegistration(actor.id, secondCompetitionId, tx as never);
  const captain = await seedCandidate(tx, "cap");
  const teamId = await startTeam(tx, thirdWorld, captain);
  await joinTeam(tx, captain, teamId, actor);
  await submitTeam(tx, thirdWorld, captain, teamId);

  const secondRows = await rowsOfUserInCompetition(tx, secondCompetitionId, actor.id);
  expect(
    secondRows.map((row) => row.status),
    "seed: the actor holds a live individual entry in the second competition",
  ).toEqual(["confirmed"]);
  const thirdMembership = await membershipStatusesOfUser(tx, teamId, actor.id);
  expect(thirdMembership, "seed: the actor is active on a registered team of the third").toEqual([
    "active",
  ]);
  const thirdTeamRows = await rowsOfTeam(tx, teamId);
  expect(
    thirdTeamRows.every((status) => status !== "cancelled"),
    "seed: the third competition's team holds only live registrations",
  ).toBe(true);
  const rowsHere = await rowsOfUserInCompetition(tx, world.competitionId, actor.id);
  expect(rowsHere, "seed: the actor has no row in the competition written to").toEqual([]);
  const membershipsHere = await teamMembershipsInCompetition(tx, world.competitionId, actor.id);
  expect(membershipsHere, "seed: the actor has no team membership in it either").toEqual([]);

  return actor.id;
};

const buildActorWithNoEntry = async (tx: Tx, world: World): Promise<string> => {
  const actor = await seedCandidate(tx, "free");

  const rows = await rowsOfUserInCompetition(tx, world.competitionId, actor.id);
  expect(rows, "seed: the actor has no row in the competition").toEqual([]);
  const memberships = await teamMembershipsInCompetition(tx, world.competitionId, actor.id);
  expect(memberships, "seed: the actor has no team membership in it").toEqual([]);

  return actor.id;
};

// ---------------------------------------------------------------------------------------------
// The three writers, each preceded by the rows another staff member leaves for it to act on.

type Actor = { actorUserId: string; actorMembershipId: string };

const staffActor = async (tx: Tx, world: World, actorId: string): Promise<Actor> => {
  const actorMembershipId = await seedStaffMembership(
    tx,
    world.institutionId,
    actorId,
    "institution_staff",
  );
  return { actorUserId: actorId, actorMembershipId };
};

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
  expectApplied: (tx: Tx, world: World, registrationId: string) => Promise<void>;
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
  expectApplied: async (tx, world, registrationId) => {
    const rows = await snapshotResultRows(tx, world);
    expect(
      rows.map((row) => ({
        registrationId: row.registrationId,
        status: row.resultStatus,
        label: row.resultLabel,
      })),
    ).toEqual([{ registrationId, status: "draft", label: "Dicoba lagi" }]);
  },
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
  expectApplied: async (tx, world, registrationId) => {
    const rows = await snapshotResultRows(tx, world);
    expect(
      rows.map((row) => ({
        registrationId: row.registrationId,
        status: row.resultStatus,
        label: row.resultLabel,
      })),
    ).toEqual([{ registrationId, status: "published", label: "Juara 1" }]);
    expect(await countAuditRows(tx, world, "result_published")).toBe(1);
  },
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
  expectApplied: async (tx, world, registrationId) => {
    const rows = await snapshotResultRows(tx, world);
    expect(
      rows.map((row) => ({
        registrationId: row.registrationId,
        status: row.resultStatus,
        label: row.resultLabel,
      })),
    ).toEqual([{ registrationId, status: "draft", label: "Juara 1" }]);
    expect(await countAuditRows(tx, world, "result_unpublished")).toBe(1);
  },
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

const REFUSED_ACTORS = [
  { actor: "has a live registration of their own", build: buildActorWithOwnIndividualEntry },
  {
    actor: "is an active member of a registered team and has no row of their own",
    build: buildActorWithTeamPlaceAndNoRow,
  },
];

const ALLOWED_ACTORS = [
  { actor: "withdrew their own registration", build: buildActorWithCancelledOwnEntry },
  {
    actor: "is on a team whose registration the captain cancelled",
    build: buildActorOnTeamWhoseRegistrationWasCancelled,
  },
  {
    actor: "has entries only in other competitions",
    build: buildActorWithEntriesInOtherCompetitionsOnly,
  },
  {
    actor: "was removed from a team that registered again",
    build: buildFormerMemberOfRegisteredTeam,
  },
  { actor: "has no entry", build: buildActorWithNoEntry },
];

describe.skipIf(skipWithoutDatabase)(
  "a result write by a host who holds an entry in the competition (real database)",
  () => {
    describe.each(REFUSED_ACTORS)("refuses an actor who $actor", ({ build }) => {
      it.each(WRITERS)("for $name on another entrant's registration", async (writer) => {
        await inRollback(async (tx) => {
          const world = await seedWorld(tx);
          const actorId = await build(tx, world);
          const targetRegistrationId = await buildTargetEntrant(tx, world);
          await writer.prepareRows(tx, world, targetRegistrationId);
          const actor = await staffActor(tx, world, actorId);
          const before = await readPostState(tx, world);

          const refusal = await refusalOf(writer.attempt(tx, world, targetRegistrationId, actor));

          const after = await readPostState(tx, world);
          expect(after, POST_STATE).toEqual(before);
          expect(refusal?.code).toBe("result_actor_is_entrant");
          expect(refusal?.status).toBe(403);
        });
      });
    });

    describe.each(REFUSED_ACTORS)(
      "refuses an actor who $actor after the event ended",
      ({ build }) => {
        it.each(WRITERS)("for $name on another entrant's registration", async (writer) => {
          await inRollback(async (tx) => {
            const world = await seedWorld(tx);
            const actorId = await build(tx, world);
            const targetRegistrationId = await buildTargetEntrant(tx, world);
            await writer.prepareRows(tx, world, targetRegistrationId);
            await endTheEvent(tx, world.competitionId);
            const [row] = await tx
              .select({ eventEndAt: competitions.eventEndAt })
              .from(competitions)
              .where(eq(competitions.id, world.competitionId));
            expect(row!.eventEndAt!.getTime() < Date.now(), "seed: the event has ended").toBe(true);
            const actor = await staffActor(tx, world, actorId);
            const before = await readPostState(tx, world);

            const refusal = await refusalOf(writer.attempt(tx, world, targetRegistrationId, actor));

            const after = await readPostState(tx, world);
            expect(after, POST_STATE).toEqual(before);
            expect(refusal?.code).toBe("result_actor_is_entrant");
            expect(refusal?.status).toBe(403);
          });
        });
      },
    );

    describe.each(ALLOWED_ACTORS)("allows an actor who $actor", ({ build }) => {
      it.each(WRITERS)("for $name on another entrant's registration", async (writer) => {
        await inRollback(async (tx) => {
          const world = await seedWorld(tx);
          const actorId = await build(tx, world);
          const targetRegistrationId = await buildTargetEntrant(tx, world);
          await writer.prepareRows(tx, world, targetRegistrationId);
          const actor = await staffActor(tx, world, actorId);

          await writer.attempt(tx, world, targetRegistrationId, actor);

          await writer.expectApplied(tx, world, targetRegistrationId);
        });
      });
    });

    describe("refuses the entrant ahead of the other refusals", () => {
      it("for upsertResultDraft over a published result", async () => {
        await inRollback(async (tx) => {
          const world = await seedWorld(tx);
          const actorId = await buildActorWithOwnIndividualEntry(tx, world);
          const targetRegistrationId = await buildTargetEntrant(tx, world);
          await writeDraftAsOwner(tx, world, targetRegistrationId);
          await publishAsOwner(tx, world, targetRegistrationId);
          const actor = await staffActor(tx, world, actorId);
          const before = await readPostState(tx, world);
          expect(
            before.resultRows.map((row) => row.resultStatus),
            "seed: the result is published, so an unguarded draft would be refused as published",
          ).toEqual(["published"]);

          const refusal = await refusalOf(
            draftWriter.attempt(tx, world, targetRegistrationId, actor),
          );

          const after = await readPostState(tx, world);
          expect(after, POST_STATE).toEqual(before);
          expect(refusal?.code).toBe("result_actor_is_entrant");
          expect(refusal?.status).toBe(403);
        });
      });

      it("for publishResult on a draft with no label", async () => {
        await inRollback(async (tx) => {
          const world = await seedWorld(tx);
          const actorId = await buildActorWithOwnIndividualEntry(tx, world);
          const targetRegistrationId = await buildTargetEntrant(tx, world);
          await upsertResultDraft(
            world.institutionId,
            world.competitionId,
            targetRegistrationId,
            world.ownerId,
            { resultLabel: null, resultNotes: null },
            tx as never,
          );
          const actor = await staffActor(tx, world, actorId);
          const before = await readPostState(tx, world);
          expect(
            before.resultRows.map((row) => ({
              status: row.resultStatus,
              label: row.resultLabel,
            })),
            "seed: the draft has no label, so an unguarded publish would be refused as unlabelled",
          ).toEqual([{ status: "draft", label: null }]);

          const refusal = await refusalOf(
            publishWriter.attempt(tx, world, targetRegistrationId, actor),
          );

          const after = await readPostState(tx, world);
          expect(after, POST_STATE).toEqual(before);
          expect(refusal?.code).toBe("result_actor_is_entrant");
          expect(refusal?.status).toBe(403);
        });
      });
    });

    describe("refuses the own-entry sentence first when the target is the actor's own entry", () => {
      it.each(WRITERS)("for $name", async (writer) => {
        await inRollback(async (tx) => {
          const world = await seedWorld(tx);
          const candidate = await seedCandidate(tx, "solo");
          const registration = await createIndividualRegistration(
            candidate.id,
            world.competitionId,
            tx as never,
          );
          await writer.prepareRows(tx, world, registration.id);
          const actor = await staffActor(tx, world, candidate.id);
          const before = await readPostState(tx, world);

          const refusal = await refusalOf(writer.attempt(tx, world, registration.id, actor));

          const after = await readPostState(tx, world);
          expect(after, POST_STATE).toEqual(before);
          expect(refusal?.code).toBe("result_own_place");
          expect(refusal?.status).toBe(403);
        });
      });
    });
  },
);
