// @vitest-environment node

import { afterAll, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  institutionMemberships,
  institutions,
  teamInvitations,
  teamMemberships,
  teams,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { RegistrationError } from "@/server/registrations/registration-core";
import {
  cancelRegistration,
  createIndividualRegistration,
} from "@/server/registrations/registration-service";
import { TeamError } from "@/server/teams/team-core";
import {
  acceptTeamInvitationForUser,
  createTeam,
  inviteTeamMember,
} from "@/server/teams/team-service";
import { submitTeamRegistration } from "@/server/teams/team-registration-service";
import { suspendInstitution } from "@/server/moderation/moderation-service";
import { deidentifyAccount } from "@/server/accounts/account-deidentification-service";

vi.mock("@/server/async/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/async/enqueue")>();
  const everyFunctionSpied = Object.fromEntries(
    Object.entries(actual)
      .filter(([, exported]) => typeof exported === "function")
      .map(([name]) => [name, vi.fn(async () => ({}))]),
  );
  return { ...actual, ...everyFunctionSpied };
});

vi.mock("@/server/storage/r2.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/storage/r2.client")>()),
  isR2Available: () => true,
  listObjects: async () => [],
  deleteObject: async () => undefined,
  headObject: async () => ({ sizeBytes: 2048, contentType: "image/jpeg" }),
}));

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
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

const DAY_MS = 24 * 60 * 60 * 1000;

const SUSPENDED_COPY =
  "Penyelenggara kompetisi ini sedang dinonaktifkan, jadi pendaftaran baru belum dapat diterima.";

// The deletion runs its own transactions as savepoints of the test's transaction, so nothing commits.
const savepointShimFor = (tx: Tx): Database =>
  ({
    transaction: async (fn: (nested: Tx) => Promise<unknown>) => tx.transaction(fn),
  }) as unknown as Database;

type Person = { id: string; username: string };

const seedPerson = async (
  tx: Tx,
  label: string,
  extra: Partial<typeof users.$inferInsert> = {},
): Promise<Person> => {
  const id = uniqueSuffix();
  const username = `si_${label}_${Date.now().toString(36)}${seq}`;
  const [row] = await tx
    .insert(users)
    .values({
      email: `suspended_inst_${label}_${id}@example.test`,
      username,
      ...extra,
    })
    .returning({ id: users.id });
  return { id: row!.id, username };
};

const seedCandidate = (tx: Tx, label: string): Promise<Person> =>
  seedPerson(tx, label, { candidateVerifiedAt: new Date() });

type Fixture = {
  operator: Person;
  owner: Person;
  workspaceId: string;
  competitionId: string;
  captain: Person;
  invitee: Person;
  solo: Person;
  other: Person;
};

const buildFixture = async (tx: Tx): Promise<Fixture> => {
  const id = uniqueSuffix();
  const operator = await seedPerson(tx, "operator", {
    role: "platform_ops",
    candidateVerifiedAt: new Date(),
  });
  const owner = await seedCandidate(tx, "owner");

  const [workspace] = await tx
    .insert(institutions)
    .values({
      slug: `suspended-inst-${id}`,
      institutionType: "company",
      displayName: `Suspended Inst ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionMemberships).values({
    institutionId: workspace!.id,
    userId: owner.id,
    membershipRole: "institution_owner",
    status: "active",
  });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: workspace!.id,
      slug: `suspended-inst-comp-${id}`,
      title: `Suspended Inst ${id}`,
      status: "published",
      mode: "both",
      minTeamSize: 2,
      maxTeamSize: 4,
      registrationStartAt: new Date(Date.now() - 10 * DAY_MS),
      registrationEndAt: new Date(Date.now() + 30 * DAY_MS),
      eventStartAt: new Date(Date.now() + 60 * DAY_MS),
      allowCancellation: true,
      cancellationCutoffDays: 1,
    })
    .returning({ id: competitions.id });

  return {
    operator,
    owner,
    workspaceId: workspace!.id,
    competitionId: competition!.id,
    captain: await seedCandidate(tx, "captain"),
    invitee: await seedCandidate(tx, "invitee"),
    solo: await seedCandidate(tx, "solo"),
    other: await seedCandidate(tx, "other"),
  };
};

const suspendWorkspaceThroughModeration = async (tx: Tx, fixture: Fixture): Promise<void> => {
  await suspendInstitution(
    fixture.operator.id,
    fixture.workspaceId,
    "Uji penangguhan pendaftaran",
    tx as never,
  );
};

const rejectionOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to refuse, but it resolved");
};

const registrationsOf = (tx: Tx, competitionId: string) =>
  tx
    .select({ id: competitionRegistrations.id })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.competitionId, competitionId));

const teamsOf = (tx: Tx, competitionId: string) =>
  tx.select({ id: teams.id }).from(teams).where(eq(teams.competitionId, competitionId));

describe.skipIf(skipWithoutDatabase)(
  "a registration on a competition of a suspended workspace, against a real database",
  () => {
    it("refuses an individual registration on a competition of a workspace staff suspended, and writes no row", async () => {
      await inRollback(async (tx) => {
        const fixture = await buildFixture(tx);
        await suspendWorkspaceThroughModeration(tx, fixture);

        const error = await rejectionOf(
          createIndividualRegistration(fixture.solo.id, fixture.competitionId, tx as never),
        );

        expect(error).toBeInstanceOf(RegistrationError);
        expect(error).toMatchObject({
          code: "institution_suspended",
          status: 403,
          message: SUSPENDED_COPY,
        });
        expect(await registrationsOf(tx, fixture.competitionId)).toHaveLength(0);
      });
    });

    it("refuses an individual registration on a competition of a workspace an account deletion anonymised", async () => {
      await inRollback(async (tx) => {
        const fixture = await buildFixture(tx);
        await deidentifyAccount(
          fixture.operator.id,
          fixture.owner.id,
          { confirmUsername: fixture.owner.username, reason: "Uji penghapusan akun" },
          savepointShimFor(tx),
        );
        const [workspaceAfterDeletion] = await tx
          .select({ suspendedAt: institutions.suspendedAt, displayName: institutions.displayName })
          .from(institutions)
          .where(eq(institutions.id, fixture.workspaceId));
        expect(workspaceAfterDeletion!.suspendedAt).not.toBeNull();
        expect(workspaceAfterDeletion!.displayName).toBe("Institusi dihapus");

        const error = await rejectionOf(
          createIndividualRegistration(fixture.solo.id, fixture.competitionId, tx as never),
        );

        expect(error).toBeInstanceOf(RegistrationError);
        expect(error).toMatchObject({
          code: "institution_suspended",
          status: 403,
          message: SUSPENDED_COPY,
        });
        expect(await registrationsOf(tx, fixture.competitionId)).toHaveLength(0);
      });
    });

    it("refuses creating a team on a competition of a suspended workspace, and writes no team", async () => {
      await inRollback(async (tx) => {
        const fixture = await buildFixture(tx);
        await suspendWorkspaceThroughModeration(tx, fixture);

        const error = await rejectionOf(
          createTeam(fixture.other.id, fixture.competitionId, { name: "Tim Ditolak" }, tx as never),
        );

        expect(error).toBeInstanceOf(TeamError);
        expect(error).toMatchObject({
          code: "institution_suspended",
          status: 403,
          message: SUSPENDED_COPY,
        });
        expect(await teamsOf(tx, fixture.competitionId)).toHaveLength(0);
      });
    });

    it("refuses joining a team on a competition of a suspended workspace, and leaves the invitation pending", async () => {
      await inRollback(async (tx) => {
        const fixture = await buildFixture(tx);
        const team = await createTeam(
          fixture.captain.id,
          fixture.competitionId,
          { name: "Tim Uji" },
          tx as never,
        );
        const invitation = await inviteTeamMember(
          fixture.captain.id,
          team.id,
          { invitedIdentifier: fixture.invitee.username },
          tx as never,
        );
        await suspendWorkspaceThroughModeration(tx, fixture);

        const error = await rejectionOf(
          acceptTeamInvitationForUser(invitation.id, fixture.invitee.id, tx as never),
        );

        expect(error).toBeInstanceOf(TeamError);
        expect(error).toMatchObject({
          code: "institution_suspended",
          status: 403,
          message: SUSPENDED_COPY,
        });
        const inviteeMemberships = await tx
          .select({ id: teamMemberships.id })
          .from(teamMemberships)
          .where(
            and(
              eq(teamMemberships.teamId, team.id),
              eq(teamMemberships.userId, fixture.invitee.id),
              eq(teamMemberships.status, "active"),
            ),
          );
        expect(inviteeMemberships).toHaveLength(0);
        const [invitationRow] = await tx
          .select({ status: teamInvitations.status })
          .from(teamInvitations)
          .where(eq(teamInvitations.id, invitation.id));
        expect(invitationRow!.status).toBe("pending");
      });
    });

    it("refuses submitting a team on a competition of a suspended workspace, and registers nobody", async () => {
      await inRollback(async (tx) => {
        const fixture = await buildFixture(tx);
        const team = await createTeam(
          fixture.captain.id,
          fixture.competitionId,
          { name: "Tim Uji" },
          tx as never,
        );
        await inviteTeamMember(
          fixture.captain.id,
          team.id,
          { invitedIdentifier: fixture.invitee.username },
          tx as never,
        );
        await suspendWorkspaceThroughModeration(tx, fixture);

        const error = await rejectionOf(
          submitTeamRegistration(fixture.captain.id, fixture.competitionId, team.id, tx as never),
        );

        expect(error).toBeInstanceOf(TeamError);
        expect(error).toMatchObject({
          code: "institution_suspended",
          status: 403,
          message: SUSPENDED_COPY,
        });
        expect(await registrationsOf(tx, fixture.competitionId)).toHaveLength(0);
        const [teamRow] = await tx
          .select({ status: teams.status })
          .from(teams)
          .where(eq(teams.id, team.id));
        expect(teamRow!.status).toBe("forming");
      });
    });

    it("keeps cancelling open after the workspace is suspended", async () => {
      await inRollback(async (tx) => {
        const fixture = await buildFixture(tx);
        const registration = await createIndividualRegistration(
          fixture.solo.id,
          fixture.competitionId,
          tx as never,
        );
        await suspendWorkspaceThroughModeration(tx, fixture);

        const cancelled = await cancelRegistration(
          fixture.solo.id,
          fixture.competitionId,
          registration.id,
          "Jadwal bentrok",
          tx as never,
        );

        expect(cancelled.status).toBe("cancelled");
        const [registrationRow] = await tx
          .select({ status: competitionRegistrations.status })
          .from(competitionRegistrations)
          .where(eq(competitionRegistrations.id, registration.id));
        expect(registrationRow!.status).toBe("cancelled");
      });
    });
  },
);
