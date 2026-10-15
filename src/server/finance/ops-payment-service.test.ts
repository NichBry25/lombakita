// @vitest-environment node
//
// The two DEC-0132 escape-hatch writers resolve their acting account from the database inside the
// one transaction that holds their writes, and refuse an operator who is a party to what they are
// deciding (LAUNCH-D136): tied to the institution for the cancel, the payer or tied to the
// institution for the void. The real-database proof lives in
// ops-payment-operator-db.integration.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { enqueueCompetitionCancelled, enqueueCompetitionSearchSync } = vi.hoisted(() => ({
  enqueueCompetitionCancelled: vi.fn(),
  enqueueCompetitionSearchSync: vi.fn(),
}));
vi.mock("@/server/async/enqueue", () => ({
  enqueueCompetitionCancelled,
  enqueueCompetitionSearchSync,
}));

const { acquireCompetitionParticipationLock } = vi.hoisted(() => ({
  acquireCompetitionParticipationLock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/competitions/competition-participation-lock", () => ({
  acquireCompetitionParticipationLock,
}));

const { notifyPaymentOutcome } = vi.hoisted(() => ({
  notifyPaymentOutcome: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server/finance/payment-notifications", () => ({ notifyPaymentOutcome }));

const { voidManualPaymentProof, ManualProofError } = vi.hoisted(() => {
  class ManualProofError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number = 422,
    ) {
      super(message);
    }
  }
  return { voidManualPaymentProof: vi.fn(), ManualProofError };
});
vi.mock("@/server/finance/manual-payment-proof-service", () => ({
  ManualProofError,
  voidManualPaymentProof,
}));

import { cancelCompetitionAsOps, voidPaymentProofAsOps } from "./ops-payment-service";
import type { Database } from "@/server/db/client";
import { OperatorActorError } from "@/server/platform-ops/operator-actor";
import { OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE } from "@/server/institution-verification/operator-institution-conflict";
import {
  CONFLICTED_RELATIONSHIP_CASES,
  NO_INSTITUTION_RELATIONSHIP_READS,
  invalidOperatorActorCases,
  makeSequencedSelect,
  operatorActorRow,
  type SelectRows,
} from "@/server/testing/operator-writer-stubs";

const OPS_ACTOR_ID = "ops_1";
const NOW = new Date("2026-10-15T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  acquireCompetitionParticipationLock.mockResolvedValue(undefined);
  enqueueCompetitionCancelled.mockResolvedValue(undefined);
  enqueueCompetitionSearchSync.mockResolvedValue(undefined);
  notifyPaymentOutcome.mockResolvedValue(undefined);
});

const makeTx = (reads: SelectRows[], updateReturns: SelectRows[] = []) => {
  const inserted: Array<Record<string, unknown>> = [];
  let updateCall = 0;
  const tx = {
    select: makeSequencedSelect(reads),
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: vi.fn().mockResolvedValue(updateReturns[updateCall++] ?? []),
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return Promise.resolve(undefined);
      },
    })),
  };
  const db = {
    select: vi.fn(),
    transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
  } as unknown as Database;
  return { db, tx, inserted };
};

describe("cancelCompetitionAsOps operator integrity", () => {
  const competition = { id: "comp_1", institutionId: "inst_1", status: "published" };

  // Reads in call order: the acting account, the competition, the institution-relationship reads.
  const makeCancelDb = (
    extras: {
      actorRow?: SelectRows[number] | null;
      competitionRows?: SelectRows;
      relationshipReads?: SelectRows[];
    } = {},
  ) => {
    const actorRow =
      extras.actorRow === undefined ? operatorActorRow(OPS_ACTOR_ID) : extras.actorRow;
    return makeTx(
      [
        actorRow ? [actorRow] : [],
        extras.competitionRows ?? [competition],
        ...(extras.relationshipReads ?? NO_INSTITUTION_RELATIONSHIP_READS),
      ],
      [[{ id: "comp_1" }], [{ id: "reg_1" }, { id: "reg_2" }]],
    );
  };

  it.each(invalidOperatorActorCases(OPS_ACTOR_ID))(
    "refuses a $label actor before taking the lock, and writes nothing",
    async ({ row, code }) => {
      const { db, tx, inserted } = makeCancelDb({ actorRow: row });
      const refusal = await cancelCompetitionAsOps(OPS_ACTOR_ID, "comp_1", "reason", db, NOW).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({ code, status: 403 });
      expect(acquireCompetitionParticipationLock).not.toHaveBeenCalled();
      expect(tx.update).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
      expect(enqueueCompetitionCancelled).not.toHaveBeenCalled();
    },
  );

  it.each(CONFLICTED_RELATIONSHIP_CASES)(
    "refuses an operator with a $arm relationship to the institution, and writes nothing",
    async ({ reads }) => {
      const { db, tx, inserted } = makeCancelDb({ relationshipReads: reads });
      const refusal = await cancelCompetitionAsOps(OPS_ACTOR_ID, "comp_1", "reason", db, NOW).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({
        code: "operator_actor_conflicted",
        status: 403,
        message: OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
      });
      expect(tx.update).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
      expect(enqueueCompetitionCancelled).not.toHaveBeenCalled();
    },
  );

  it("404s a competition that does not exist, and writes nothing", async () => {
    const { db, tx, inserted } = makeCancelDb({ competitionRows: [] });
    await expect(
      cancelCompetitionAsOps(OPS_ACTOR_ID, "missing", "reason", db, NOW),
    ).rejects.toMatchObject({ code: "ops_competition_not_found", status: 404 });
    expect(tx.update).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("validates an empty reason before any database work", async () => {
    const { db, tx } = makeCancelDb();
    await expect(
      cancelCompetitionAsOps(OPS_ACTOR_ID, "comp_1", "  ", db, NOW),
    ).rejects.toMatchObject({ code: "ops_reason_required" });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
  });

  it("writes exactly one audit row naming the database actor", async () => {
    const { db, inserted } = makeCancelDb({ actorRow: operatorActorRow("database-actor") });
    const result = await cancelCompetitionAsOps("claimed-actor", "comp_1", " reason ", db, NOW);
    expect(result).toEqual({ competitionId: "comp_1", cancelledRegistrationCount: 2 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      actorUserId: "database-actor",
      targetInstitutionId: "inst_1",
      eventType: "platform_ops_competition_cancelled",
      reason: "reason",
    });
  });
});

describe("voidPaymentProofAsOps operator integrity", () => {
  const parties = { payerUserId: "payer_1", receivingInstitutionId: "inst_1" };
  const voidedProof = {
    id: "proof_1",
    paymentId: "pay_1",
    competitionId: "comp_1",
    resubmissionCount: 0,
  };

  // Reads in call order: the acting account, the proof's payer and receiving institution, the
  // institution-relationship reads, then the competition the audit row targets.
  const makeVoidDb = (
    extras: {
      actorRow?: SelectRows[number] | null;
      partiesRows?: SelectRows;
      relationshipReads?: SelectRows[];
      competitionRows?: SelectRows;
    } = {},
  ) => {
    const actorRow =
      extras.actorRow === undefined ? operatorActorRow(OPS_ACTOR_ID) : extras.actorRow;
    const partiesRows = extras.partiesRows ?? [parties];
    const reads: SelectRows[] = [actorRow ? [actorRow] : [], partiesRows];
    if (partiesRows.length > 0) {
      reads.push(...(extras.relationshipReads ?? NO_INSTITUTION_RELATIONSHIP_READS));
    }
    reads.push(extras.competitionRows ?? [{ institutionId: "inst_1" }]);
    return makeTx(reads);
  };

  beforeEach(() => {
    voidManualPaymentProof.mockResolvedValue(voidedProof);
  });

  it.each(invalidOperatorActorCases(OPS_ACTOR_ID))(
    "refuses a $label actor before reading the proof, and writes nothing",
    async ({ row, code }) => {
      const { db, inserted } = makeVoidDb({ actorRow: row });
      const refusal = await voidPaymentProofAsOps(OPS_ACTOR_ID, "proof_1", "reason", db, NOW).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({ code, status: 403 });
      expect(voidManualPaymentProof).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
      expect(notifyPaymentOutcome).not.toHaveBeenCalled();
    },
  );

  it("refuses an operator who is the payer, before voiding anything", async () => {
    const { db, inserted } = makeVoidDb({
      partiesRows: [{ ...parties, payerUserId: OPS_ACTOR_ID }],
    });
    const refusal = await voidPaymentProofAsOps(OPS_ACTOR_ID, "proof_1", "reason", db, NOW).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({
      code: "operator_actor_is_target",
      status: 403,
      message: "A platform-ops account cannot act on a payment it made",
    });
    expect(voidManualPaymentProof).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(notifyPaymentOutcome).not.toHaveBeenCalled();
  });

  it.each(CONFLICTED_RELATIONSHIP_CASES)(
    "refuses an operator with a $arm relationship to the receiving institution",
    async ({ reads }) => {
      const { db, inserted } = makeVoidDb({ relationshipReads: reads });
      const refusal = await voidPaymentProofAsOps(OPS_ACTOR_ID, "proof_1", "reason", db, NOW).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({
        code: "operator_actor_conflicted",
        status: 403,
        message: OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
      });
      expect(voidManualPaymentProof).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
      expect(notifyPaymentOutcome).not.toHaveBeenCalled();
    },
  );

  it("lets voidManualPaymentProof raise its own not-found when the proof has no parties row", async () => {
    voidManualPaymentProof.mockRejectedValueOnce(
      new ManualProofError("manual_proof_not_found", "Bukti transfer tidak ditemukan", 404),
    );
    const { db, inserted } = makeVoidDb({ partiesRows: [] });
    await expect(
      voidPaymentProofAsOps(OPS_ACTOR_ID, "missing", "reason", db, NOW),
    ).rejects.toMatchObject({ code: "manual_proof_not_found", status: 404 });
    expect(inserted).toHaveLength(0);
  });

  it("passes the database actor to voidManualPaymentProof and writes one audit row naming it", async () => {
    const { db, tx, inserted } = makeVoidDb({ actorRow: operatorActorRow("database-actor") });
    await voidPaymentProofAsOps("claimed-actor", "proof_1", " reason ", db, NOW);
    expect(voidManualPaymentProof).toHaveBeenCalledWith(
      "database-actor",
      "proof_1",
      "reason",
      tx,
      NOW,
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      actorUserId: "database-actor",
      targetInstitutionId: "inst_1",
      eventType: "platform_ops_payment_proof_voided",
      reason: "reason",
    });
  });

  it("names the actor as target when the competition cannot be read", async () => {
    const { db, inserted } = makeVoidDb({
      actorRow: operatorActorRow("database-actor"),
      competitionRows: [],
    });
    await voidPaymentProofAsOps("claimed-actor", "proof_1", "reason", db, NOW);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      actorUserId: "database-actor",
      targetUserId: "database-actor",
    });
  });

  it("validates an empty reason before any database work", async () => {
    const { db, tx } = makeVoidDb();
    await expect(
      voidPaymentProofAsOps(OPS_ACTOR_ID, "proof_1", " ", db, NOW),
    ).rejects.toMatchObject({
      code: "ops_reason_required",
    });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
  });
});
