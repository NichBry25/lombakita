// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  financeFeeRules,
  financePayments,
  institutionMemberships,
  institutionPaymentInstructions,
  institutions,
  teamInvitations,
  teamMemberships,
  teams,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";

const serviceState = vi.hoisted(() => ({ testRunStarted: false }));

vi.mock("@/server/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/client")>();
  return {
    ...actual,
    getDb: () => {
      if (!serviceState.testRunStarted) return actual.getDb();
      throw new Error("a service read the database outside the test's transaction");
    },
  };
});

const enqueueSpies = vi.hoisted(() => ({
  enqueueRegistrationConfirmed: vi.fn(),
  enqueueRegistrationCancelled: vi.fn(),
  enqueuePaymentProofSubmitted: vi.fn(),
  enqueuePaymentOutcome: vi.fn(),
  enqueueCompetitionCancelled: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn(),
  enqueueTeamInvitationDispatch: vi.fn(),
}));

vi.mock("@/server/async/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/async/enqueue")>()),
  ...enqueueSpies,
}));

vi.mock("@/server/storage/r2.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/storage/r2.client")>()),
  headObject: vi.fn(async () => ({ sizeBytes: 2048, contentType: "image/jpeg" })),
  deleteObject: vi.fn(async () => undefined),
}));

import {
  transitionCompetitionStatus,
  unpublishCompetition,
} from "@/server/competitions/competition-service";
import { cancelCompetitionAsOps } from "@/server/finance/ops-payment-service";
import {
  rejectManualPaymentProof,
  submitManualPaymentProof,
  verifyManualPaymentProof,
} from "@/server/finance/manual-payment-proof-service";
import { sweepExpiredPayments } from "@/server/finance/payment-expiry-service";
import {
  createIndividualRegistration,
  getStudentRegistration,
  hasPaymentProofOnCancelledIndividualRegistrations,
} from "@/server/registrations/registration-service";
import { createTeam, disbandTeam } from "@/server/teams/team-service";
import { submitTeamRegistration } from "@/server/teams/team-registration-service";
import { hashToken } from "@/server/teams/team-core";

beforeAll(() => {
  serviceState.testRunStarted = true;
});

beforeEach(() => {
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
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

const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;
const uniqueSuffix = (): string => `${Date.now().toString(36)}${seq++}`;

type Outcome = { ok: true } | { ok: false; code: string; status: number };

const outcomeOf = async (work: Promise<unknown>): Promise<Outcome> => {
  try {
    await work;
    return { ok: true };
  } catch (error) {
    const coded = error as { code?: unknown; status?: unknown; httpStatus?: unknown };
    if (typeof coded.code !== "string") throw error;
    const status = typeof coded.status === "number" ? coded.status : coded.httpStatus;
    return { ok: false, code: coded.code, status: status as number };
  }
};

const seedCandidate = async (tx: Tx, label: string): Promise<string> => {
  const username = `fresh_${label}_${uniqueSuffix()}`;
  const [row] = await tx
    .insert(users)
    .values({
      email: `${username}@example.test`,
      username,
      emailVerified: new Date(),
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
};

const seedOwner = async (tx: Tx): Promise<string> => {
  const username = `fresh_owner_${uniqueSuffix()}`;
  const [row] = await tx
    .insert(users)
    .values({
      email: `${username}@example.test`,
      username,
      emailVerified: new Date(),
      role: "recruiter",
      recruiterVerifiedAt: new Date(),
      recruiterVerificationTier: "elevated",
    })
    .returning({ id: users.id });
  return row!.id;
};

const seedOperator = async (tx: Tx): Promise<string> => {
  const username = `fresh_ops_${uniqueSuffix()}`;
  const [row] = await tx
    .insert(users)
    .values({
      email: `${username}@example.test`,
      username,
      role: "platform_ops",
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
};

type Seed = { ownerId: string; institutionId: string; competitionId: string };

/**
 * A published competition that takes individuals and teams of 2 to 4, with everything publishing
 * it again needs. A paid one charges Rp150.000 through a verified institution that can take payment.
 */
const seedCompetition = async (tx: Tx, paid: boolean): Promise<Seed> => {
  const suffix = uniqueSuffix();
  const ownerId = await seedOwner(tx);

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `fresh-inst-${suffix}`,
      institutionType: "company",
      displayName: `Fresh Start ${suffix}`,
      verificationStatus: "verified",
    })
    .returning({ id: institutions.id });

  await tx.insert(institutionMemberships).values({
    institutionId: institution!.id,
    userId: ownerId,
    membershipRole: "institution_owner",
    status: "active",
  });

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
      slug: `fresh-comp-${suffix}`,
      title: `Kompetisi ${suffix}`,
      description: "Deskripsi kompetisi untuk pengujian.",
      category: "hackathon",
      mode: "both",
      minTeamSize: 2,
      maxTeamSize: 4,
      status: "published",
      publishedAt: new Date(),
      registrationStartAt: new Date(Date.now() - 7 * DAY_MS),
      registrationEndAt: new Date(Date.now() + 14 * DAY_MS),
      participantConfirmationAt: new Date(Date.now() + 20 * DAY_MS),
      eventStartAt: new Date(Date.now() + 30 * DAY_MS),
      eventEndAt: new Date(Date.now() + 31 * DAY_MS),
      resultAnnouncementAt: new Date(Date.now() + 40 * DAY_MS),
      allowCancellation: true,
      cancellationCutoffDays: 1,
      organizerContactKind: "whatsapp",
      organizerContactValue: "628123456789",
      ...(paid ? { feeAmount: 150_000, feeCurrency: "IDR", paymentWindowDays: 3 } : {}),
    })
    .returning({ id: competitions.id });

  return { ownerId, institutionId: institution!.id, competitionId: competition!.id };
};

const registerWithProof = async (
  tx: Tx,
  seed: Seed,
  candidateId: string,
): Promise<{ registrationId: string; proofId: string }> => {
  const registration = await createIndividualRegistration(
    candidateId,
    seed.competitionId,
    tx as never,
  );
  const [payment] = await tx
    .select({ id: financePayments.id })
    .from(financePayments)
    .where(eq(financePayments.competitionRegistrationId, registration.id));
  const proof = await submitManualPaymentProof(
    {
      paymentId: payment!.id,
      submittedByUserId: candidateId,
      r2Key: `payment-proofs/${seed.competitionId}/${payment!.id}/bukti.jpg`,
      originalFileName: "bukti.jpg",
    },
    tx as never,
  );
  return { registrationId: registration.id, proofId: proof.id };
};

const rejectProof = (tx: Tx, seed: Seed, proofId: string) =>
  rejectManualPaymentProof(
    seed.institutionId,
    seed.ownerId,
    proofId,
    "nominal tidak sesuai",
    true,
    tx as never,
  );

const publishAgain = (tx: Tx, seed: Seed) =>
  transitionCompetitionStatus(seed.ownerId, seed.competitionId, "published", tx as never);

const registrationStatusesOf = async (
  tx: Tx,
  candidateId: string,
  competitionId: string,
): Promise<string[]> => {
  const rows = await tx
    .select({ status: competitionRegistrations.status })
    .from(competitionRegistrations)
    .where(
      and(
        eq(competitionRegistrations.studentId, candidateId),
        eq(competitionRegistrations.competitionId, competitionId),
      ),
    );
  return rows.map((row) => row.status).sort();
};

/** What a person meets on coming back after a republish, read before and through registering. */
const comingBackOf = async (tx: Tx, seed: Seed, candidateId: string) => {
  const pageRegistration = await getStudentRegistration(
    candidateId,
    seed.competitionId,
    tx as never,
  );
  const proofBlocks = await hasPaymentProofOnCancelledIndividualRegistrations(
    candidateId,
    seed.competitionId,
    tx as never,
  );
  const registeredAgain = await outcomeOf(
    createIndividualRegistration(candidateId, seed.competitionId, tx as never),
  );
  return {
    pageRegistration: pageRegistration?.status ?? null,
    proofBlocks,
    registeredAgain,
    statuses: await registrationStatusesOf(tx, candidateId, seed.competitionId),
  };
};

const joinTeam = async (tx: Tx, teamId: string, userId: string): Promise<void> => {
  await tx.insert(teamMemberships).values({ teamId, userId, role: "member", status: "active" });
};

const seedOpenInvite = async (
  tx: Tx,
  teamId: string,
  captainId: string,
  targetUserId: string | null,
): Promise<void> => {
  await tx.insert(teamInvitations).values({
    teamId,
    invitedByUserId: captainId,
    invitedEmail: `fresh_invitee_${uniqueSuffix()}@example.test`,
    targetUserId,
    tokenHash: hashToken(randomUUID()),
    status: targetUserId === null ? "pending_claim" : "pending",
    expiresAt: new Date(Date.now() + 14 * DAY_MS),
  });
};

const teamStateOf = async (tx: Tx, teamId: string) => {
  const [team] = await tx.select({ status: teams.status }).from(teams).where(eq(teams.id, teamId));
  const memberships = await tx
    .select({ status: teamMemberships.status })
    .from(teamMemberships)
    .where(eq(teamMemberships.teamId, teamId));
  const invitations = await tx
    .select({ status: teamInvitations.status })
    .from(teamInvitations)
    .where(eq(teamInvitations.teamId, teamId));
  return {
    team: team!.status,
    memberships: memberships.map((row) => row.status).sort(),
    invitations: invitations.map((row) => row.status).sort(),
  };
};

const teamRegistrationsOf = async (tx: Tx, teamId: string) => {
  const rows = await tx
    .select({
      status: competitionRegistrations.status,
      cancellationReason: competitionRegistrations.cancellationReason,
    })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.teamId, teamId));
  return rows;
};

describe.skipIf(skipWithoutDatabase)(
  "unpublishing ends the publication: teams are disbanded and nothing from it refuses anyone after a republish",
  () => {
    it("after an unpublish and a republish, a person whose proof was rejected registers again as if for the first time", async () => {
      await inRollback(async (tx) => {
        const seed = await seedCompetition(tx, true);
        const dewi = await seedCandidate(tx, "dewi");
        const { proofId } = await registerWithProof(tx, seed, dewi);
        await rejectProof(tx, seed, proofId);

        await unpublishCompetition(seed.ownerId, seed.competitionId, tx as never);
        await publishAgain(tx, seed);

        expect(await comingBackOf(tx, seed, dewi)).toEqual({
          pageRegistration: null,
          proofBlocks: false,
          registeredAgain: { ok: true },
          statuses: ["cancelled", "confirmed"],
        });
      });
    });

    it("after an unpublish and a republish, a person whose registration lapsed after a rejected proof registers again", async () => {
      await inRollback(async (tx) => {
        const seed = await seedCompetition(tx, true);
        const dewi = await seedCandidate(tx, "dewi");
        const { proofId } = await registerWithProof(tx, seed, dewi);
        await rejectProof(tx, seed, proofId);
        await sweepExpiredPayments(new Date(Date.now() + 5 * DAY_MS), tx as never);

        await unpublishCompetition(seed.ownerId, seed.competitionId, tx as never);
        await publishAgain(tx, seed);

        expect(await comingBackOf(tx, seed, dewi)).toEqual({
          pageRegistration: null,
          proofBlocks: false,
          registeredAgain: { ok: true },
          statuses: ["cancelled", "confirmed"],
        });
      });
    });

    it("an unpublish disbands every team, a registered one and a forming one, with their memberships and open invites", async () => {
      await inRollback(async (tx) => {
        const seed = await seedCompetition(tx, false);
        const rina = await seedCandidate(tx, "rina");
        const budi = await seedCandidate(tx, "budi");
        const sari = await seedCandidate(tx, "sari");
        const wati = await seedCandidate(tx, "wati");
        const registered = await createTeam(
          rina,
          seed.competitionId,
          { name: `Tim Rina ${uniqueSuffix()}` },
          tx as never,
        );
        await joinTeam(tx, registered.id, budi);
        await seedOpenInvite(tx, registered.id, rina, sari);
        await submitTeamRegistration(rina, seed.competitionId, registered.id, tx as never);
        const forming = await createTeam(
          wati,
          seed.competitionId,
          { name: `Tim Wati ${uniqueSuffix()}` },
          tx as never,
        );
        await seedOpenInvite(tx, forming.id, wati, null);

        await unpublishCompetition(seed.ownerId, seed.competitionId, tx as never);

        expect({
          registered: await teamStateOf(tx, registered.id),
          forming: await teamStateOf(tx, forming.id),
          registrations: await teamRegistrationsOf(tx, registered.id),
        }).toEqual({
          registered: {
            team: "cancelled",
            memberships: ["removed", "removed"],
            invitations: ["cancelled"],
          },
          forming: { team: "cancelled", memberships: ["removed"], invitations: ["cancelled"] },
          registrations: [
            { status: "cancelled", cancellationReason: "competition_cancelled_by_institution" },
            { status: "cancelled", cancellationReason: "competition_cancelled_by_institution" },
          ],
        });
      });
    });

    it("after an unpublish and a republish, the captain of a disbanded team forms a team again under the same name", async () => {
      await inRollback(async (tx) => {
        const seed = await seedCompetition(tx, false);
        const rina = await seedCandidate(tx, "rina");
        const budi = await seedCandidate(tx, "budi");
        const name = `Tim Rina ${uniqueSuffix()}`;
        const first = await createTeam(rina, seed.competitionId, { name }, tx as never);
        await joinTeam(tx, first.id, budi);
        await submitTeamRegistration(rina, seed.competitionId, first.id, tx as never);

        await unpublishCompetition(seed.ownerId, seed.competitionId, tx as never);
        await publishAgain(tx, seed);
        const formedAgain = await outcomeOf(
          createTeam(rina, seed.competitionId, { name }, tx as never),
        );

        const namesakes = await tx
          .select({ status: teams.status })
          .from(teams)
          .where(and(eq(teams.competitionId, seed.competitionId), eq(teams.name, name)));
        expect({
          formedAgain,
          statuses: namesakes.map((row) => row.status).sort(),
        }).toEqual({ formedAgain: { ok: true }, statuses: ["cancelled", "forming"] });
      });
    });

    it("a new team can take the name of a team its captain disbanded", async () => {
      await inRollback(async (tx) => {
        const seed = await seedCompetition(tx, false);
        const rina = await seedCandidate(tx, "rina");
        const wati = await seedCandidate(tx, "wati");
        const name = `Tim Garuda ${uniqueSuffix()}`;
        const first = await createTeam(rina, seed.competitionId, { name }, tx as never);
        await disbandTeam(rina, first.id, tx as never);

        expect({
          created: await outcomeOf(createTeam(wati, seed.competitionId, { name }, tx as never)),
        }).toEqual({ created: { ok: true } });
      });
    });

    it("a platform_ops cancellation disbands every team too", async () => {
      await inRollback(async (tx) => {
        const seed = await seedCompetition(tx, false);
        const operatorId = await seedOperator(tx);
        const wati = await seedCandidate(tx, "wati");
        const sari = await seedCandidate(tx, "sari");
        const forming = await createTeam(
          wati,
          seed.competitionId,
          { name: `Tim Wati ${uniqueSuffix()}` },
          tx as never,
        );
        await seedOpenInvite(tx, forming.id, wati, sari);

        await cancelCompetitionAsOps(
          operatorId,
          seed.competitionId,
          "penyelenggara tidak dapat menyelenggarakan acara",
          tx as never,
        );

        expect({ forming: await teamStateOf(tx, forming.id) }).toEqual({
          forming: { team: "cancelled", memberships: ["removed"], invitations: ["cancelled"] },
        });
      });
    });

    it("after a platform_ops cancellation and a republish, a person whose proof was awaiting verification registers again", async () => {
      await inRollback(async (tx) => {
        const seed = await seedCompetition(tx, true);
        const operatorId = await seedOperator(tx);
        const dewi = await seedCandidate(tx, "dewi");
        await registerWithProof(tx, seed, dewi);

        await cancelCompetitionAsOps(
          operatorId,
          seed.competitionId,
          "penyelenggara tidak dapat menyelenggarakan acara",
          tx as never,
        );
        await publishAgain(tx, seed);

        expect(await comingBackOf(tx, seed, dewi)).toEqual({
          pageRegistration: null,
          proofBlocks: false,
          registeredAgain: { ok: true },
          statuses: ["cancelled", "confirmed"],
        });
      });
    });

    it("an unpublish is refused while a registration is paid, and nothing is cancelled or disbanded", async () => {
      await inRollback(async (tx) => {
        const seed = await seedCompetition(tx, true);
        const dewi = await seedCandidate(tx, "dewi");
        const wati = await seedCandidate(tx, "wati");
        const { proofId } = await registerWithProof(tx, seed, dewi);
        await verifyManualPaymentProof(seed.institutionId, seed.ownerId, proofId, tx as never);
        const forming = await createTeam(
          wati,
          seed.competitionId,
          { name: `Tim Wati ${uniqueSuffix()}` },
          tx as never,
        );

        const unpublish = await outcomeOf(
          unpublishCompetition(seed.ownerId, seed.competitionId, tx as never),
        );

        const [competition] = await tx
          .select({ status: competitions.status })
          .from(competitions)
          .where(eq(competitions.id, seed.competitionId));
        expect({
          unpublish,
          competitionStatus: competition!.status,
          statuses: await registrationStatusesOf(tx, dewi, seed.competitionId),
          forming: await teamStateOf(tx, forming.id),
        }).toEqual({
          unpublish: {
            ok: false,
            code: "competition_unpublish_blocked_payment_in_flight",
            status: 409,
          },
          competitionStatus: "published",
          statuses: ["confirmed"],
          forming: { team: "forming", memberships: ["active"], invitations: [] },
        });
      });
    });
  },
);
