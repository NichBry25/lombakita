// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  financeFeeRules,
  institutionPaymentInstructions,
  institutions,
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
import {
  cancelTeamRegistration,
  submitTeamRegistration,
} from "@/server/teams/team-registration-service";

const enqueueSpies = vi.hoisted(() => ({
  enqueueRegistrationConfirmed: vi.fn(),
  enqueueRegistrationCancelled: vi.fn(),
  enqueuePaymentProofSubmitted: vi.fn(),
  enqueuePaymentOutcome: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/async/enqueue")>()),
  ...enqueueSpies,
}));

const routeState = vi.hoisted(() => ({
  transaction: null as Database | null,
  actorUserId: null as string | null,
  testRunStarted: false,
}));

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    getDb: () => {
      if (routeState.transaction) return routeState.transaction;
      if (!routeState.testRunStarted) return actual.getDb();
      throw new Error("the individual cancel route read the database outside a test");
    },
  };
});

vi.mock("@/server/auth/session", () => ({
  requireSessionRole: async () => {
    if (!routeState.actorUserId) {
      throw new Error("the individual cancel route ran with no session staged");
    }
    return { user: { id: routeState.actorUserId, role: "candidate" } };
  },
}));

import { DELETE } from "@/app/api/v1/competitions/[competitionId]/registrations/[registrationId]/route";

beforeAll(() => {
  routeState.testRunStarted = true;
});

beforeEach(() => {
  routeState.transaction = null;
  routeState.actorUserId = null;
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

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
const TEAM_ROW_MESSAGE =
  "Pendaftaran ini terdaftar sebagai tim. Hanya ketua tim yang dapat membatalkan pendaftaran tim, lewat bagian Tim di halaman ini.";

const seedCandidate = async (tx: Tx, label: string): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `team_row_cancel_${label}_${id}@example.test`,
      username: `team_row_cancel_${label}_${id}`,
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
};

type RegisteredTeam = {
  captainUserId: string;
  memberUserId: string;
  soloUserId: string;
  competitionId: string;
  teamId: string;
  captainRowId: string;
  memberRowId: string;
};

const seedRegisteredTeam = async (tx: Tx): Promise<RegisteredTeam> => {
  const id = uniqueSuffix();
  const captainUserId = await seedCandidate(tx, "captain");
  const memberUserId = await seedCandidate(tx, "member");
  const soloUserId = await seedCandidate(tx, "solo");

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `team-row-cancel-inst-${id}`,
      institutionType: "company",
      displayName: `Team Row Cancel ${id}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionPaymentInstructions).values({
    institutionId: institution!.id,
    bankName: "Bank Contoh",
    accountNumber: "1234567890",
    accountHolderName: "Panitia Lomba",
  });

  await tx.insert(financeFeeRules).values({
    institutionId: institution!.id,
    currency: "IDR",
    basisPoints: 250,
    flatAmount: 0,
    effectiveFrom: new Date(Date.now() - 30 * DAY_MS),
  });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `team-row-cancel-comp-${id}`,
      title: `Team Row Cancel ${id}`,
      status: "published",
      mode: "both",
      minTeamSize: 2,
      maxTeamSize: 4,
      registrationStartAt: new Date(Date.now() - 10 * DAY_MS),
      registrationEndAt: new Date(Date.now() + 30 * DAY_MS),
      eventStartAt: new Date(Date.now() + 60 * DAY_MS),
      allowCancellation: true,
      cancellationCutoffDays: 1,
      feeAmount: 150_000,
      feeCurrency: "IDR",
      paymentWindowDays: 3,
    })
    .returning({ id: competitions.id });

  const [team] = await tx
    .insert(teams)
    .values({
      competitionId: competition!.id,
      captainId: captainUserId,
      name: `Tim ${id}`,
      status: "forming",
    })
    .returning({ id: teams.id });

  await tx.insert(teamMemberships).values([
    { teamId: team!.id, userId: captainUserId, role: "captain", status: "active" },
    { teamId: team!.id, userId: memberUserId, role: "member", status: "active" },
  ]);

  const registered = await submitTeamRegistration(
    captainUserId,
    competition!.id,
    team!.id,
    tx as never,
  );
  const captainRow = registered.registrations.find((row) => row.studentId === captainUserId);
  const memberRow = registered.registrations.find((row) => row.studentId === memberUserId);

  return {
    captainUserId,
    memberUserId,
    soloUserId,
    competitionId: competition!.id,
    teamId: team!.id,
    captainRowId: captainRow!.id,
    memberRowId: memberRow!.id,
  };
};

const teamRowsOf = (tx: Tx, teamId: string) =>
  tx
    .select({
      id: competitionRegistrations.id,
      status: competitionRegistrations.status,
      cancelledAt: competitionRegistrations.cancelledAt,
      cancellationReason: competitionRegistrations.cancellationReason,
      updatedAt: competitionRegistrations.updatedAt,
    })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.teamId, teamId))
    .orderBy(competitionRegistrations.id);

const refusalOf = async (
  work: Promise<unknown>,
): Promise<{ code: string; status: number; message: string } | null> => {
  try {
    await work;
  } catch (error) {
    if (!(error instanceof RegistrationError)) throw error;
    return { code: error.code, status: error.status, message: error.message };
  }
  return null;
};

const cancelThroughRoute = async (
  tx: Tx,
  input: { actorUserId: string; competitionId: string; registrationId: string; reason?: string },
): Promise<{ status: number; body: Record<string, unknown> }> => {
  routeState.transaction = tx as unknown as Database;
  routeState.actorUserId = input.actorUserId;

  const hasReason = input.reason !== undefined;
  const response = await DELETE(
    new Request(
      `https://lombakita.test/api/v1/competitions/${input.competitionId}/registrations/${input.registrationId}`,
      {
        method: "DELETE",
        headers: {
          "X-Expected-User-Id": input.actorUserId,
          ...(hasReason ? { "content-type": "application/json" } : {}),
        },
        body: hasReason ? JSON.stringify({ cancellationReason: input.reason }) : undefined,
      },
    ),
    {
      params: Promise.resolve({
        competitionId: input.competitionId,
        registrationId: input.registrationId,
      }),
    },
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
};

describe.skipIf(skipWithoutDatabase)(
  "the individual cancel of a team row, against a real database",
  () => {
    it("refuses a captain's own team row and a member's, and changes no row", async () => {
      await inRollback(async (tx) => {
        const seed = await seedRegisteredTeam(tx);
        const rowsBefore = await teamRowsOf(tx, seed.teamId);
        enqueueSpies.enqueueRegistrationCancelled.mockClear();

        const captainRefusal = await refusalOf(
          cancelRegistration(
            seed.captainUserId,
            seed.competitionId,
            seed.captainRowId,
            "berubah rencana",
            tx as never,
          ),
        );
        const memberRefusal = await refusalOf(
          cancelRegistration(
            seed.memberUserId,
            seed.competitionId,
            seed.memberRowId,
            "berubah rencana",
            tx as never,
          ),
        );

        const refusal = {
          code: "registration_team_row_use_team_flow",
          status: 409,
          message: TEAM_ROW_MESSAGE,
        };
        expect({
          captainRefusal,
          memberRefusal,
          rowsAfter: await teamRowsOf(tx, seed.teamId),
          cancelNotices: enqueueSpies.enqueueRegistrationCancelled.mock.calls.length,
        }).toEqual({
          captainRefusal: refusal,
          memberRefusal: refusal,
          rowsAfter: rowsBefore,
          cancelNotices: 0,
        });
        expect(rowsBefore.map((row) => row.status)).toEqual(["confirmed", "confirmed"]);
      });
    });

    it("gives the team refusal for a team row with no reason, and for a team row already cancelled", async () => {
      await inRollback(async (tx) => {
        const seed = await seedRegisteredTeam(tx);

        const withoutReason = await refusalOf(
          cancelRegistration(
            seed.memberUserId,
            seed.competitionId,
            seed.memberRowId,
            null,
            tx as never,
          ),
        );
        await cancelTeamRegistration(
          seed.captainUserId,
          seed.competitionId,
          seed.teamId,
          "berubah rencana",
          tx as never,
        );
        const afterTeamCancel = await refusalOf(
          cancelRegistration(
            seed.memberUserId,
            seed.competitionId,
            seed.memberRowId,
            "berubah rencana",
            tx as never,
          ),
        );

        expect({
          withoutReason: withoutReason?.code,
          afterTeamCancel: afterTeamCancel?.code,
        }).toEqual({
          withoutReason: "registration_team_row_use_team_flow",
          afterTeamCancel: "registration_team_row_use_team_flow",
        });
      });
    });

    it("still tells a non-owner nothing about the row being a team row", async () => {
      await inRollback(async (tx) => {
        const seed = await seedRegisteredTeam(tx);

        const refusal = await refusalOf(
          cancelRegistration(
            seed.soloUserId,
            seed.competitionId,
            seed.memberRowId,
            "berubah rencana",
            tx as never,
          ),
        );

        expect(refusal?.code).toBe("registration_not_owner");
      });
    });

    it("refuses through the route with 409 and the team message, for the captain, the member and a body-less request", async () => {
      await inRollback(async (tx) => {
        const seed = await seedRegisteredTeam(tx);
        const rowsBefore = await teamRowsOf(tx, seed.teamId);

        const captain = await cancelThroughRoute(tx, {
          actorUserId: seed.captainUserId,
          competitionId: seed.competitionId,
          registrationId: seed.captainRowId,
          reason: "berubah rencana",
        });
        const member = await cancelThroughRoute(tx, {
          actorUserId: seed.memberUserId,
          competitionId: seed.competitionId,
          registrationId: seed.memberRowId,
          reason: "berubah rencana",
        });
        const bodyless = await cancelThroughRoute(tx, {
          actorUserId: seed.memberUserId,
          competitionId: seed.competitionId,
          registrationId: seed.memberRowId,
        });

        const refused = {
          status: 409,
          body: {
            error: {
              code: "registration_team_row_use_team_flow",
              message: TEAM_ROW_MESSAGE,
              details: {},
            },
          },
        };
        expect({
          captain,
          member,
          bodyless,
          rowsAfter: await teamRowsOf(tx, seed.teamId),
        }).toEqual({ captain: refused, member: refused, bodyless: refused, rowsAfter: rowsBefore });
      });
    });

    it("cancels an individual registration exactly as before, and keeps its other refusals", async () => {
      await inRollback(async (tx) => {
        const seed = await seedRegisteredTeam(tx);
        const individual = await createIndividualRegistration(
          seed.soloUserId,
          seed.competitionId,
          tx as never,
        );

        const withoutReason = await refusalOf(
          cancelRegistration(seed.soloUserId, seed.competitionId, individual.id, null, tx as never),
        );
        const cancelled = await cancelRegistration(
          seed.soloUserId,
          seed.competitionId,
          individual.id,
          "berubah rencana",
          tx as never,
        );
        const again = await refusalOf(
          cancelRegistration(
            seed.soloUserId,
            seed.competitionId,
            individual.id,
            "berubah rencana",
            tx as never,
          ),
        );

        expect({
          withoutReason: withoutReason?.code,
          cancelledStatus: cancelled.status,
          cancelledReason: cancelled.cancellationReason,
          again: again?.code,
          notices: enqueueSpies.enqueueRegistrationCancelled.mock.calls.map(([payload]) => ({
            registrationId: payload.registrationId,
            registrationType: payload.registrationType,
          })),
        }).toEqual({
          withoutReason: "cancellation_reason_required",
          cancelledStatus: "cancelled",
          cancelledReason: "berubah rencana",
          again: "registration_wrong_status",
          notices: [{ registrationId: individual.id, registrationType: "individual" }],
        });
      });
    });
  },
);
