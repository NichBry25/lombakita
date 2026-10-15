// @vitest-environment node
//
// finance_ops opening somebody's receipt writes an audit row, and that row now names an actor the
// database confirmed holds finance_ops (LAUNCH-D136). The operator may not open a receipt for a
// payment they made, or for an institution they are tied to. The audit row must land BEFORE the URL
// is minted, so a refusal mints nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

const { isR2Available, generatePresignedGetUrl } = vi.hoisted(() => ({
  isR2Available: vi.fn(),
  generatePresignedGetUrl: vi.fn(),
}));
vi.mock("@/server/storage/r2.client", () => ({ isR2Available, generatePresignedGetUrl }));

vi.mock("@/server/finance/manual-payment-proof-service", () => {
  class ManualProofError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number = 422,
    ) {
      super(message);
    }
  }
  return { ManualProofError };
});

import {
  FILE_ACCESSED_EVENT,
  generateDisputeProofViewUrl,
  recordDisputeProofAccess,
} from "./dispute-view";
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

const FINANCE_ACTOR_ID = "finance_1";

const PROOF_ID = "proof_1";

// The row the proof-and-payment read returns: everything the audit entry and the presigner need.
const proofRow = {
  id: PROOF_ID,
  paymentId: "pay_1",
  competitionId: "comp_1",
  attempt: 0,
  payerUserId: "payer_1",
  receivingInstitutionId: "inst_1",
  r2Key: "k",
  contentType: "application/pdf",
};

beforeEach(() => {
  vi.clearAllMocks();
  isR2Available.mockReturnValue(true);
  generatePresignedGetUrl.mockResolvedValue("https://r2.example/receipt");
});

// Reads in call order, all through the transaction handle: the acting account, then the proof, then
// the four reads of the institution-relationship check. The pool handle's `select` throws, so a proof
// read that bypassed the transaction (and so could precede the actor) fails loudly.
const makeDb = (
  extras: {
    actorRow?: SelectRows[number] | null;
    relationshipReads?: SelectRows[];
    proofRows?: SelectRows;
  } = {},
) => {
  const actorRow =
    extras.actorRow === undefined
      ? operatorActorRow(FINANCE_ACTOR_ID, "finance_ops")
      : extras.actorRow;
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    select: makeSequencedSelect([
      actorRow ? [actorRow] : [],
      extras.proofRows ?? [proofRow],
      ...(extras.relationshipReads ?? NO_INSTITUTION_RELATIONSHIP_READS),
    ]),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return Promise.resolve(undefined);
      },
    })),
  };
  const db = {
    select: vi.fn(() => {
      throw new Error("the proof was read through the pool handle, outside the transaction");
    }),
    transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
  } as unknown as Database;
  return { db, tx, inserted };
};

const ACTOR_READ_ONLY = 1;

describe("recordDisputeProofAccess operator integrity", () => {
  it.each(invalidOperatorActorCases(FINANCE_ACTOR_ID, "finance_ops"))(
    "refuses a $label actor before the proof is read, and writes nothing",
    async ({ row, code }) => {
      const { db, tx, inserted } = makeDb({ actorRow: row });
      const refusal = await recordDisputeProofAccess(FINANCE_ACTOR_ID, PROOF_ID, db).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({ code, status: 403 });
      expect(tx.select).toHaveBeenCalledTimes(ACTOR_READ_ONLY);
      expect(inserted).toHaveLength(0);
    },
  );

  it("refuses a platform_ops actor before the proof is read, because the route admits finance_ops only", async () => {
    const { db, tx, inserted } = makeDb({
      actorRow: operatorActorRow(FINANCE_ACTOR_ID, "platform_ops"),
    });
    const refusal = await recordDisputeProofAccess(FINANCE_ACTOR_ID, PROOF_ID, db).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({ code: "operator_actor_not_platform_ops", status: 403 });
    expect(tx.select).toHaveBeenCalledTimes(ACTOR_READ_ONLY);
    expect(inserted).toHaveLength(0);
  });

  it.each(invalidOperatorActorCases(FINANCE_ACTOR_ID, "finance_ops"))(
    "answers a $label actor naming an unknown proof with the actor refusal, not manual_proof_not_found",
    async ({ row, code }) => {
      const { db } = makeDb({ actorRow: row, proofRows: [] });
      const refusal = await recordDisputeProofAccess(FINANCE_ACTOR_ID, "unknown", db).catch(
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({ code, status: 403 });
      expect(refusal).not.toMatchObject({ code: "manual_proof_not_found" });
    },
  );

  it("404s an unknown proof for a valid finance_ops actor, writing nothing", async () => {
    const { db, inserted } = makeDb({ proofRows: [] });
    await expect(recordDisputeProofAccess(FINANCE_ACTOR_ID, "missing", db)).rejects.toMatchObject({
      code: "manual_proof_not_found",
      message: "Bukti transfer tidak ditemukan",
      status: 404,
    });
    expect(inserted).toHaveLength(0);
  });

  it("refuses an operator who is the payer", async () => {
    const { db, inserted } = makeDb({
      proofRows: [{ ...proofRow, payerUserId: FINANCE_ACTOR_ID }],
    });
    const refusal = await recordDisputeProofAccess(FINANCE_ACTOR_ID, PROOF_ID, db).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(OperatorActorError);
    expect(refusal).toMatchObject({
      code: "operator_actor_is_target",
      status: 403,
      message: "A platform-ops account cannot act on a payment it made",
    });
    expect(inserted).toHaveLength(0);
  });

  it.each(CONFLICTED_RELATIONSHIP_CASES)(
    "refuses an operator with a $arm relationship to the receiving institution",
    async ({ reads }) => {
      const { db, inserted } = makeDb({ relationshipReads: reads });
      const refusal = await recordDisputeProofAccess(FINANCE_ACTOR_ID, PROOF_ID, db).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(OperatorActorError);
      expect(refusal).toMatchObject({
        code: "operator_actor_conflicted",
        status: 403,
        message: OPERATOR_ACTOR_CONFLICTED_ACTION_MESSAGE,
      });
      expect(inserted).toHaveLength(0);
    },
  );

  it("writes exactly one audit row naming the database actor, and returns the file to open", async () => {
    const { db, inserted } = makeDb({
      actorRow: operatorActorRow("database-finance", "finance_ops"),
    });
    const file = await recordDisputeProofAccess("claimed-finance", PROOF_ID, db);
    expect(file).toEqual({ r2Key: "k", contentType: "application/pdf" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual({
      actorUserId: "database-finance",
      targetUserId: "payer_1",
      targetInstitutionId: "inst_1",
      eventType: FILE_ACCESSED_EVENT,
      reason: "Penanganan sengketa pembayaran",
      metadata: { proofId: "proof_1", paymentId: "pay_1", competitionId: "comp_1", attempt: 0 },
    });
  });
});

describe("generateDisputeProofViewUrl audit ordering", () => {
  it("writes the audit row before the URL is minted", async () => {
    const { db, tx } = makeDb();
    const result = await generateDisputeProofViewUrl(FINANCE_ACTOR_ID, PROOF_ID, db);
    expect(result).toEqual({ url: "https://r2.example/receipt", contentType: "application/pdf" });
    expect(generatePresignedGetUrl).toHaveBeenCalledWith("k", 120, {
      responseContentType: "application/pdf",
      responseContentDisposition: "inline",
    });
    expect(tx.insert.mock.invocationCallOrder[0]!).toBeLessThan(
      generatePresignedGetUrl.mock.invocationCallOrder[0]!,
    );
  });

  it("mints no URL when the operator is refused", async () => {
    const { db } = makeDb({ actorRow: null });
    await expect(generateDisputeProofViewUrl(FINANCE_ACTOR_ID, PROOF_ID, db)).rejects.toMatchObject(
      { code: "operator_actor_not_found" },
    );
    expect(generatePresignedGetUrl).not.toHaveBeenCalled();
  });

  it.each(invalidOperatorActorCases(FINANCE_ACTOR_ID, "finance_ops"))(
    "refuses a $label actor before the proof is read, even for a proof id that does not exist",
    async ({ row, code }) => {
      const { db, tx } = makeDb({ actorRow: row, proofRows: [] });
      const refusal = await generateDisputeProofViewUrl(FINANCE_ACTOR_ID, "unknown", db).catch(
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({ code, status: 403 });
      expect(tx.select).toHaveBeenCalledTimes(ACTOR_READ_ONLY);
      expect(generatePresignedGetUrl).not.toHaveBeenCalled();
    },
  );

  it("opens no transaction, reads nothing and writes nothing when storage is unavailable", async () => {
    isR2Available.mockReturnValue(false);
    const { db, tx } = makeDb();
    await expect(generateDisputeProofViewUrl(FINANCE_ACTOR_ID, PROOF_ID, db)).rejects.toMatchObject(
      { code: "manual_proof_upload_unavailable", status: 503 },
    );
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
  });

  it("404s a proof that does not exist before any audit write or URL", async () => {
    const { db, inserted } = makeDb({ proofRows: [] });
    await expect(
      generateDisputeProofViewUrl(FINANCE_ACTOR_ID, "missing", db),
    ).rejects.toMatchObject({
      code: "manual_proof_not_found",
      status: 404,
    });
    expect(inserted).toHaveLength(0);
    expect(generatePresignedGetUrl).not.toHaveBeenCalled();
  });
});
