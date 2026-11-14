// @vitest-environment node

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import {
  competitionRegistrations,
  competitions,
  financeFeeRules,
  financePaymentEvents,
  financePayments,
  institutionPaymentInstructions,
  institutions,
  teamMemberships,
  teams,
  users,
} from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { TeamError } from "@/server/teams/team-core";
import {
  cancelTeamRegistration,
  hasPaymentProofOnCancelledTeamRegistrations,
  submitTeamRegistration,
} from "@/server/teams/team-registration-service";
import {
  rejectManualPaymentProof,
  submitManualPaymentProof,
  verifyManualPaymentProof,
} from "@/server/finance/manual-payment-proof-service";
import { sweepExpiredPayments } from "@/server/finance/payment-expiry-service";
import { loadCandidatePaymentView } from "@/server/finance/candidate-payment-view";
import {
  createIndividualRegistration,
  hasPaymentProofOnCancelledIndividualRegistrations,
} from "@/server/registrations/registration-service";

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

vi.mock("@/server/storage/r2.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/storage/r2.client")>()),
  headObject: vi.fn(async () => ({ sizeBytes: 2048, contentType: "image/jpeg" })),
  deleteObject: vi.fn(async () => undefined),
}));

const readyEnqueueSpies = () => {
  for (const spy of Object.values(enqueueSpies)) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
};

beforeEach(readyEnqueueSpies);

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

let seq = 0;
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

const T0 = new Date("2026-09-01T03:00:00.000Z");
const WITHDRAWN_AT = new Date("2026-09-01T04:00:00.000Z");
const REGISTERED_AGAIN_AT = new Date("2026-09-02T03:00:00.000Z");
const VERIFIED_AT = new Date("2026-09-02T04:00:00.000Z");
const SWEEP_AT = new Date("2026-09-04T04:00:00.000Z");
const AFTER_SWEEP = new Date("2026-09-04T05:00:00.000Z");

const refusalOf = async (
  work: Promise<unknown>,
): Promise<{ code: string; status: number } | null> => {
  try {
    await work;
  } catch (error) {
    if (!(error instanceof TeamError)) throw error;
    return { code: error.code, status: error.status };
  }
  return null;
};

const seedUser = async (tx: Tx, label: string, suffix: string): Promise<string> => {
  const [row] = await tx
    .insert(users)
    .values({
      email: `proof_rule_${label}_${suffix}@example.test`,
      username: `proof_rule_${label}_${suffix}`,
      candidateVerifiedAt: T0,
    })
    .returning({ id: users.id });
  return row!.id;
};

const seedPricedTeam = async (
  tx: Tx,
  mode: "team" | "both",
): Promise<{
  organiserUserId: string;
  captainUserId: string;
  memberUserId: string;
  institutionId: string;
  competitionId: string;
  teamId: string;
}> => {
  const suffix = uniqueSuffix();

  const organiserUserId = await seedUser(tx, "organiser", suffix);
  const captainUserId = await seedUser(tx, "captain", suffix);
  const memberUserId = await seedUser(tx, "member", suffix);

  const [institution] = await tx
    .insert(institutions)
    .values({
      slug: `proof-rule-inst-${suffix}`,
      institutionType: "company",
      displayName: `Proof Rule ${suffix}`,
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
    effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
  });

  const [competition] = await tx
    .insert(competitions)
    .values({
      institutionId: institution!.id,
      slug: `proof-rule-comp-${suffix}`,
      title: `Proof Rule ${suffix}`,
      status: "published",
      mode,
      minTeamSize: 2,
      maxTeamSize: 4,
      registrationStartAt: new Date("2026-08-25T00:00:00.000Z"),
      registrationEndAt: new Date("2026-10-01T00:00:00.000Z"),
      eventStartAt: new Date("2026-11-01T00:00:00.000Z"),
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
      name: `Tim ${suffix}`,
      status: "forming",
    })
    .returning({ id: teams.id });

  await tx.insert(teamMemberships).values([
    { teamId: team!.id, userId: captainUserId, role: "captain", status: "active" },
    { teamId: team!.id, userId: memberUserId, role: "member", status: "active" },
  ]);

  return {
    organiserUserId,
    captainUserId,
    memberUserId,
    institutionId: institution!.id,
    competitionId: competition!.id,
    teamId: team!.id,
  };
};

const paymentIdAnchoredOn = async (tx: Tx, registrationId: string): Promise<string> => {
  const [payment] = await tx
    .select({ id: financePayments.id })
    .from(financePayments)
    .where(eq(financePayments.competitionRegistrationId, registrationId));
  return payment!.id;
};

const sendProof = async (
  tx: Tx,
  paymentId: string,
  payerUserId: string,
  competitionId: string,
): Promise<string> => {
  const proof = await submitManualPaymentProof(
    {
      paymentId,
      submittedByUserId: payerUserId,
      r2Key: `payment-proofs/${competitionId}/${paymentId}/bukti.jpg`,
      originalFileName: "bukti.jpg",
    },
    tx as never,
  );
  return proof.id;
};

const teamRowsOf = (tx: Tx, teamId: string) =>
  tx
    .select({
      id: competitionRegistrations.id,
      status: competitionRegistrations.status,
      cancellationReason: competitionRegistrations.cancellationReason,
    })
    .from(competitionRegistrations)
    .where(eq(competitionRegistrations.teamId, teamId));

const teamStatusOf = async (tx: Tx, teamId: string): Promise<string> => {
  const [team] = await tx.select({ status: teams.status }).from(teams).where(eq(teams.id, teamId));
  return team!.status;
};

const eventCount = async (tx: Tx, paymentId: string, eventType: string): Promise<number> => {
  const events = await tx
    .select({ eventType: financePaymentEvents.eventType })
    .from(financePaymentEvents)
    .where(eq(financePaymentEvents.paymentId, paymentId));
  return events.filter((event) => event.eventType === eventType).length;
};

const expiredOutcomeSentFor = (paymentId: string): boolean =>
  enqueueSpies.enqueuePaymentOutcome.mock.calls.some(
    ([payload]) => payload.paymentId === paymentId && payload.outcome === "expired",
  );

describe.skipIf(skipWithoutDatabase)("registering a team again after a payment proof", () => {
  it("keeps a team whose proof was rejected and whose payment lapsed from registering again, even after the fee is cleared", async () => {
    await inRollback(async (tx) => {
      const seed = await seedPricedTeam(tx, "team");
      const first = await submitTeamRegistration(
        seed.captainUserId,
        seed.competitionId,
        seed.teamId,
        tx as never,
        T0,
      );
      const captainRow = first.registrations.find((row) => row.studentId === seed.captainUserId);
      const firstPaymentId = await paymentIdAnchoredOn(tx, captainRow!.id);
      const proofId = await sendProof(tx, firstPaymentId, seed.captainUserId, seed.competitionId);
      await rejectManualPaymentProof(
        seed.institutionId,
        seed.organiserUserId,
        proofId,
        "nominal tidak sesuai",
        true,
        tx as never,
        WITHDRAWN_AT,
      );
      await sweepExpiredPayments(SWEEP_AT, tx as never);

      const rowsAfterSweep = await teamRowsOf(tx, seed.teamId);
      expect({
        rows: rowsAfterSweep.map((row) => ({
          status: row.status,
          cancellationReason: row.cancellationReason,
        })),
        teamStatus: await teamStatusOf(tx, seed.teamId),
      }).toEqual({
        rows: [
          { status: "cancelled", cancellationReason: "payment_deadline_expired" },
          { status: "cancelled", cancellationReason: "payment_deadline_expired" },
        ],
        teamStatus: "submitted",
      });

      await tx
        .update(competitions)
        .set({ feeAmount: null, feeCurrency: null })
        .where(eq(competitions.id, seed.competitionId));
      const refusal = await refusalOf(
        submitTeamRegistration(
          seed.captainUserId,
          seed.competitionId,
          seed.teamId,
          tx as never,
          AFTER_SWEEP,
        ),
      );

      const rowsAfterRefusal = await teamRowsOf(tx, seed.teamId);
      const anchoredPayments = await tx
        .select({ id: financePayments.id })
        .from(financePayments)
        .where(
          inArray(
            financePayments.competitionRegistrationId,
            rowsAfterRefusal.map((row) => row.id),
          ),
        );
      expect({
        refusal,
        rowIds: rowsAfterRefusal.map((row) => row.id).sort(),
        rowStatuses: rowsAfterRefusal.map((row) => row.status),
        paymentIds: anchoredPayments.map((payment) => payment.id),
        proofOnCancelledRows: await hasPaymentProofOnCancelledTeamRegistrations(
          seed.teamId,
          seed.competitionId,
          tx as never,
        ),
      }).toEqual({
        refusal: { code: "team_not_forming", status: 409 },
        rowIds: first.registrations.map((row) => row.id).sort(),
        rowStatuses: ["cancelled", "cancelled"],
        paymentIds: [firstPaymentId],
        proofOnCancelledRows: true,
      });
    });
  });

  it("lets a team register when a member's own cancelled individual registration had a proof", async () => {
    await inRollback(async (tx) => {
      const seed = await seedPricedTeam(tx, "both");
      const individual = await createIndividualRegistration(
        seed.memberUserId,
        seed.competitionId,
        tx as never,
        T0,
      );
      const individualPaymentId = await paymentIdAnchoredOn(tx, individual.id);
      const proofId = await sendProof(
        tx,
        individualPaymentId,
        seed.memberUserId,
        seed.competitionId,
      );
      await rejectManualPaymentProof(
        seed.institutionId,
        seed.organiserUserId,
        proofId,
        "nominal tidak sesuai",
        true,
        tx as never,
        WITHDRAWN_AT,
      );
      await sweepExpiredPayments(SWEEP_AT, tx as never);

      const teamResult = await submitTeamRegistration(
        seed.captainUserId,
        seed.competitionId,
        seed.teamId,
        tx as never,
        AFTER_SWEEP,
      );

      const [individualRow] = await tx
        .select({ status: competitionRegistrations.status })
        .from(competitionRegistrations)
        .where(eq(competitionRegistrations.id, individual.id));
      expect({
        individualStatus: individualRow!.status,
        teamStatus: teamResult.status,
        teamRowStatuses: teamResult.registrations.map((row) => row.status),
        teamProofOnCancelledRows: await hasPaymentProofOnCancelledTeamRegistrations(
          seed.teamId,
          seed.competitionId,
          tx as never,
        ),
        individualProofOnCancelledRows: await hasPaymentProofOnCancelledIndividualRegistrations(
          seed.memberUserId,
          seed.competitionId,
          tx as never,
        ),
      }).toEqual({
        individualStatus: "cancelled",
        teamStatus: "submitted",
        teamRowStatuses: ["confirmed", "confirmed"],
        teamProofOnCancelledRows: false,
        individualProofOnCancelledRows: true,
      });
    });
  });

  it("lets the captain register as an individual after a proof on the team's cancelled registration", async () => {
    await inRollback(async (tx) => {
      const seed = await seedPricedTeam(tx, "both");
      const first = await submitTeamRegistration(
        seed.captainUserId,
        seed.competitionId,
        seed.teamId,
        tx as never,
        T0,
      );
      const captainRow = first.registrations.find((row) => row.studentId === seed.captainUserId);
      const firstPaymentId = await paymentIdAnchoredOn(tx, captainRow!.id);
      const proofId = await sendProof(tx, firstPaymentId, seed.captainUserId, seed.competitionId);
      await rejectManualPaymentProof(
        seed.institutionId,
        seed.organiserUserId,
        proofId,
        "nominal tidak sesuai",
        true,
        tx as never,
        WITHDRAWN_AT,
      );
      await sweepExpiredPayments(SWEEP_AT, tx as never);

      const individual = await createIndividualRegistration(
        seed.captainUserId,
        seed.competitionId,
        tx as never,
        AFTER_SWEEP,
      );

      expect(individual.status).toBe("confirmed");
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the expiry of a team payment", () => {
  it("cancels only the registrations made with the old payment once the team registered again and paid", async () => {
    await inRollback(async (tx) => {
      const seed = await seedPricedTeam(tx, "team");
      const first = await submitTeamRegistration(
        seed.captainUserId,
        seed.competitionId,
        seed.teamId,
        tx as never,
        T0,
      );
      const firstCaptainRow = first.registrations.find(
        (row) => row.studentId === seed.captainUserId,
      );
      const firstPaymentId = await paymentIdAnchoredOn(tx, firstCaptainRow!.id);
      await cancelTeamRegistration(
        seed.captainUserId,
        seed.competitionId,
        seed.teamId,
        "berubah rencana",
        tx as never,
        WITHDRAWN_AT,
      );
      const second = await submitTeamRegistration(
        seed.captainUserId,
        seed.competitionId,
        seed.teamId,
        tx as never,
        REGISTERED_AGAIN_AT,
      );
      const secondCaptainRow = second.registrations.find(
        (row) => row.studentId === seed.captainUserId,
      );
      const secondPaymentId = await paymentIdAnchoredOn(tx, secondCaptainRow!.id);
      const proofId = await sendProof(tx, secondPaymentId, seed.captainUserId, seed.competitionId);
      await verifyManualPaymentProof(
        seed.institutionId,
        seed.organiserUserId,
        proofId,
        tx as never,
        VERIFIED_AT,
      );

      const firstRowIds = first.registrations.map((row) => row.id);
      const readFirstRows = () =>
        tx
          .select({
            id: competitionRegistrations.id,
            status: competitionRegistrations.status,
            cancelledAt: competitionRegistrations.cancelledAt,
            cancellationReason: competitionRegistrations.cancellationReason,
            updatedAt: competitionRegistrations.updatedAt,
          })
          .from(competitionRegistrations)
          .where(inArray(competitionRegistrations.id, firstRowIds))
          .orderBy(competitionRegistrations.id);
      const firstRowsBeforeSweep = await readFirstRows();

      enqueueSpies.enqueuePaymentOutcome.mockClear();
      const result = await sweepExpiredPayments(SWEEP_AT, tx as never);

      const firstRowsAfterSweep = await readFirstRows();
      const secondRows = await tx
        .select({ status: competitionRegistrations.status })
        .from(competitionRegistrations)
        .where(
          inArray(
            competitionRegistrations.id,
            second.registrations.map((row) => row.id),
          ),
        );
      expect({
        outcomes: result.expired.filter(
          (entry) => entry.paymentId === firstPaymentId || entry.paymentId === secondPaymentId,
        ),
        secondRowStatuses: secondRows.map((row) => row.status),
        firstRows: firstRowsAfterSweep,
        firstPaymentExpiredEvents: await eventCount(tx, firstPaymentId, "expired"),
        secondPaymentSucceededEvents: await eventCount(tx, secondPaymentId, "succeeded"),
        expiredOutcomeSent: expiredOutcomeSentFor(firstPaymentId),
      }).toEqual({
        outcomes: [{ paymentId: firstPaymentId, registrationsCancelled: 0 }],
        secondRowStatuses: ["confirmed", "confirmed"],
        firstRows: firstRowsBeforeSweep,
        firstPaymentExpiredEvents: 1,
        secondPaymentSucceededEvents: 1,
        expiredOutcomeSent: false,
      });
    });
  });

  it("still cancels every registration made with a team payment that lapses", async () => {
    await inRollback(async (tx) => {
      const seed = await seedPricedTeam(tx, "team");
      const registered = await submitTeamRegistration(
        seed.captainUserId,
        seed.competitionId,
        seed.teamId,
        tx as never,
        T0,
      );
      const captainRow = registered.registrations.find(
        (row) => row.studentId === seed.captainUserId,
      );
      const paymentId = await paymentIdAnchoredOn(tx, captainRow!.id);

      const result = await sweepExpiredPayments(SWEEP_AT, tx as never);

      const rows = await teamRowsOf(tx, seed.teamId);
      expect({
        outcomes: result.expired.filter((entry) => entry.paymentId === paymentId),
        rows: rows.map((row) => ({
          status: row.status,
          cancellationReason: row.cancellationReason,
        })),
        expiredOutcomeSent: expiredOutcomeSentFor(paymentId),
      }).toEqual({
        outcomes: [{ paymentId, registrationsCancelled: 2 }],
        rows: [
          { status: "cancelled", cancellationReason: "payment_deadline_expired" },
          { status: "cancelled", cancellationReason: "payment_deadline_expired" },
        ],
        expiredOutcomeSent: true,
      });
    });
  });
});

describe.skipIf(skipWithoutDatabase)("the payment panel after a team registered again", () => {
  it("shows the team's newest payment, open for its proof, after the team registered again", async () => {
    await inRollback(async (tx) => {
      const seed = await seedPricedTeam(tx, "team");
      const first = await submitTeamRegistration(
        seed.captainUserId,
        seed.competitionId,
        seed.teamId,
        tx as never,
        T0,
      );
      await cancelTeamRegistration(
        seed.captainUserId,
        seed.competitionId,
        seed.teamId,
        "berubah rencana",
        tx as never,
        WITHDRAWN_AT,
      );
      const second = await submitTeamRegistration(
        seed.captainUserId,
        seed.competitionId,
        seed.teamId,
        tx as never,
        REGISTERED_AGAIN_AT,
      );
      const rowOf = (result: typeof first, userId: string) =>
        result.registrations.find((row) => row.studentId === userId)!.id;
      const secondPaymentId = await paymentIdAnchoredOn(tx, rowOf(second, seed.captainUserId));

      const views = [
        await loadCandidatePaymentView(
          rowOf(second, seed.captainUserId),
          seed.captainUserId,
          tx as never,
        ),
        await loadCandidatePaymentView(
          rowOf(first, seed.captainUserId),
          seed.captainUserId,
          tx as never,
        ),
        await loadCandidatePaymentView(
          rowOf(second, seed.memberUserId),
          seed.memberUserId,
          tx as never,
        ),
      ];

      expect(
        views.map((view) => ({
          paymentId: view?.paymentId,
          isPayer: view?.isPayer,
          canSubmitProof: view?.canSubmitProof,
        })),
      ).toEqual([
        { paymentId: secondPaymentId, isPayer: true, canSubmitProof: true },
        { paymentId: secondPaymentId, isPayer: true, canSubmitProof: true },
        { paymentId: secondPaymentId, isPayer: false, canSubmitProof: false },
      ]);
    });
  });
});
