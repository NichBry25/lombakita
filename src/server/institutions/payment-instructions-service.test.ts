// @vitest-environment node
//
// The QRIS key boundary, exercised through savePaymentInstructions (the function a request body
// actually reaches) rather than by calling assertQrisKeyBelongsToInstitution directly.
//
// Rule 33's point: a test that hands the assertion a string proves the assertion. It cannot prove
// the assertion is WIRED, and an unwired one leaves an institution able to publish another
// institution's QRIS as its own payment method.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import {
  PaymentInstructionsError,
  buildQrisObjectPrefix,
  savePaymentInstructions,
} from "@/server/institutions/payment-instructions-service";
import type { Database } from "@/server/db/client";

/** Records what reached the database, and returns a row so the happy path can complete. */
const recordingDb = () => {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          onConflictDoUpdate: () => ({
            returning: async () => [{ id: "pi_1", ...values }],
          }),
        };
      },
    }),
  } as unknown as Database;
  return { db, inserted };
};

const BANK = {
  bankName: "Bank Mandiri",
  accountNumber: "1370012345678",
  accountHolderName: "Yayasan Seed Academy",
  instructionsNote: null,
};

describe("savePaymentInstructions: the QRIS key boundary", () => {
  it("accepts a key under this institution's own prefix", async () => {
    // The positive. Every refusal below is worthless without it: they would all pass against a
    // function that refused every key it was given.
    const { db, inserted } = recordingDb();
    const key = `${buildQrisObjectPrefix("inst_a")}abc-123`;

    await savePaymentInstructions("inst_a", { ...BANK, qrisR2Key: key }, db);

    expect(inserted[0]?.qrisR2Key).toBe(key);
  });

  it("WRITES NOTHING for a key under ANOTHER institution's prefix", async () => {
    // The attack this guard exists for: publish a rival's QRIS as your own payment method and every
    // candidate who scans it pays them, while your competition records them as owing you.
    const { db, inserted } = recordingDb();

    await expect(
      savePaymentInstructions(
        "inst_a",
        { ...BANK, qrisR2Key: `${buildQrisObjectPrefix("inst_b")}abc-123` },
        db,
      ),
    ).rejects.toBeInstanceOf(PaymentInstructionsError);

    expect(inserted).toEqual([]);
  });

  it("WRITES NOTHING for a prefix that merely STARTS THE SAME", async () => {
    // `inst_a` is a prefix of `inst_alpha`, so a check written with startsWith on the id rather than
    // on the id plus its slash would let one institution's key pass as another's. The prefix helper
    // ends in "/", and this is what holds it there.
    const { db, inserted } = recordingDb();

    await expect(
      savePaymentInstructions(
        "inst_a",
        { ...BANK, qrisR2Key: "payment-instructions/inst_alpha/abc-123" },
        db,
      ),
    ).rejects.toBeInstanceOf(PaymentInstructionsError);

    expect(inserted).toEqual([]);
  });

  it("WRITES NOTHING for a traversal segment that resolves out of the prefix", async () => {
    const { db, inserted } = recordingDb();

    await expect(
      savePaymentInstructions(
        "inst_a",
        { ...BANK, qrisR2Key: `${buildQrisObjectPrefix("inst_a")}../inst_b/abc` },
        db,
      ),
    ).rejects.toBeInstanceOf(PaymentInstructionsError);

    expect(inserted).toEqual([]);
  });

  it("WRITES NOTHING for the bare prefix with no object after it", async () => {
    const { db, inserted } = recordingDb();

    await expect(
      savePaymentInstructions(
        "inst_a",
        { ...BANK, qrisR2Key: buildQrisObjectPrefix("inst_a") },
        db,
      ),
    ).rejects.toBeInstanceOf(PaymentInstructionsError);

    expect(inserted).toEqual([]);
  });
});

describe("savePaymentInstructions: what makes a row payable", () => {
  it("refuses a row naming neither a usable bank account nor a QRIS", async () => {
    // Mirrors the database CHECK. Checked here too so the organiser reads a sentence naming what is
    // missing rather than a constraint violation surfaced as a generic write failure.
    const { db, inserted } = recordingDb();

    await expect(
      savePaymentInstructions(
        "inst_a",
        {
          bankName: "Bank Mandiri",
          accountNumber: null,
          accountHolderName: null,
          qrisR2Key: null,
          instructionsNote: "Transfer sebelum batas waktu",
        },
        db,
      ),
    ).rejects.toThrow(/nama bank/);

    expect(inserted).toEqual([]);
  });

  it("treats whitespace as absent, so a spacebar cannot satisfy the account number", async () => {
    const { db, inserted } = recordingDb();

    await expect(
      savePaymentInstructions("inst_a", { ...BANK, accountNumber: "   ", qrisR2Key: null }, db),
    ).rejects.toBeInstanceOf(PaymentInstructionsError);

    expect(inserted).toEqual([]);
  });

  it("accepts a QRIS-only institution, which has no bank fields at all", async () => {
    const { db, inserted } = recordingDb();

    await savePaymentInstructions(
      "inst_a",
      {
        bankName: null,
        accountNumber: null,
        accountHolderName: null,
        qrisR2Key: `${buildQrisObjectPrefix("inst_a")}abc-123`,
        instructionsNote: null,
      },
      db,
    );

    expect(inserted[0]?.bankName).toBeNull();
    expect(inserted[0]?.qrisR2Key).toContain("inst_a");
  });
});
