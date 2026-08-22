import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institutions/payment-instructions-service");

import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { randomUUID } from "node:crypto";
import { generatePresignedPutUrl, isR2Available } from "@/server/storage/r2.client";
import {
  QRIS_FORMAT_HINT,
  qrisMimeTypeForFileName,
  type QrisMimeType,
} from "@/lib/finance/qris-file";
import {
  competitions,
  institutionPaymentInstructions,
  type InstitutionPaymentInstructionsRecord,
} from "@/server/db/schema";

// WHERE AN INSTITUTION WANTS TO BE PAID on the manual lane, and the snapshot taken of it whenever a
// payer is told.
//
// Institution-level and reused across every competition the institution runs. There is no
// per-competition override, on purpose: an organiser maintaining one copy of its bank details per
// competition is how a closed account keeps collecting nobody's money for a year.
//
// These are the INSTITUTION'S OWN account details, shown to a payer so they can transfer directly.
// The platform never holds the funds, which is exactly why it has to publish somebody else's
// account number, and why the accuracy of this row is the only thing standing between a candidate
// and money sent to an account nobody is watching.

/** One institution's payment instructions, or null when it has not set any. */
export const loadPaymentInstructionsForInstitution = async (
  institutionId: string,
  db: Database = getDb(),
): Promise<InstitutionPaymentInstructionsRecord | null> => {
  const [row] = await db
    .select()
    .from(institutionPaymentInstructions)
    .where(eq(institutionPaymentInstructions.institutionId, institutionId))
    .limit(1);

  return row ?? null;
};

/**
 * The payment instructions a candidate paying for THIS competition should follow.
 *
 * Resolved through the competition's owning institution in ONE query rather than by asking the
 * caller for an institution id. A caller that passes both a competition and an institution can pass
 * a mismatched pair, and the failure mode of that mistake is a payer sending money to the wrong
 * organiser's bank account.
 *
 * Answers only for a competition somebody can actually be paying for: PUBLISHED and not soft-
 * deleted. These are an institution's real bank account details, and a draft or withdrawn
 * competition takes no registrations and therefore no money, so publishing account details against
 * one hands them out with no transaction to justify it.
 *
 * Null means either that, or that the institution has configured no instructions, a real state a
 * paid competition must not be allowed to reach, and one the checkout surface is responsible for
 * refusing on rather than rendering blank.
 */
export const loadPaymentInstructionsForCompetition = async (
  competitionId: string,
  db: Database = getDb(),
): Promise<InstitutionPaymentInstructionsRecord | null> => {
  const [row] = await db
    .select({ instructions: institutionPaymentInstructions })
    .from(competitions)
    .innerJoin(
      institutionPaymentInstructions,
      eq(institutionPaymentInstructions.institutionId, competitions.institutionId),
    )
    .where(
      and(
        eq(competitions.id, competitionId),
        eq(competitions.status, "published"),
        isNull(competitions.deletedAt),
      ),
    )
    .limit(1);

  return row?.instructions ?? null;
};

export type PaymentInstructionsErrorCode =
  | "payment_instructions_incomplete"
  | "payment_instructions_missing"
  | "payment_instructions_qris_key_invalid"
  | "payment_instructions_qris_format_unsupported"
  | "payment_instructions_upload_unavailable";

export class PaymentInstructionsError extends Error {
  constructor(
    public readonly code: PaymentInstructionsErrorCode,
    message: string,
    public readonly status: number = 422,
  ) {
    super(message);
    this.name = "PaymentInstructionsError";
  }
}

/**
 * Where one institution's QRIS image lives in object storage.
 *
 * A NEW KEY PER UPLOAD, never a stable path, and that is the whole design. A payment snapshots the
 * QRIS key it showed its payer; overwriting the object behind a stable key would silently replace
 * the evidence of what that payer was actually shown with whatever the institution uploaded later.
 * A fresh key per upload leaves every previously-snapshotted image exactly as it was.
 *
 * Nothing deletes a superseded image, for the same reason nothing deletes a bukti transfer: an
 * outdated QRIS is still the record of what somebody was told to scan.
 */
export const buildQrisObjectPrefix = (institutionId: string): string =>
  `payment-instructions/${institutionId}/`;

/**
 * Refuses a QRIS key that is not this institution's own.
 *
 * The same boundary a bukti transfer's key is held to, and here for the same reason: the key is
 * caller-supplied, so without this an institution could point its instructions at any object in the
 * bucket, including another institution's QRIS, which its candidates would then be told to scan.
 */
export const assertQrisKeyBelongsToInstitution = (r2Key: string, institutionId: string): void => {
  const prefix = buildQrisObjectPrefix(institutionId);
  const hasTraversalSegment = r2Key.split("/").includes("..");

  if (!r2Key.startsWith(prefix) || r2Key.length === prefix.length || hasTraversalSegment) {
    throw new PaymentInstructionsError(
      "payment_instructions_qris_key_invalid",
      "Berkas QRIS tidak tersimpan di ruang penyimpanan institusi ini",
    );
  }
};

/**
 * The fields of an institution's payment instructions that are EVIDENCE of what a payer was told.
 *
 * Derived from the source record's own key set rather than listed independently, so adding a column
 * to `institution_payment_instructions` is a COMPILE ERROR here until it is either snapshotted or
 * deliberately named in the exclusion below. A field silently missing from the snapshot is the
 * failure this type exists to make impossible: it would break no test, it would just quietly stop
 * being evidence.
 *
 * The exclusions are the row's own bookkeeping (identity, tenancy and timestamps), none of which
 * is something a payer was shown.
 */
type InstructionEvidenceField = Exclude<
  keyof InstitutionPaymentInstructionsRecord,
  "id" | "institutionId" | "createdAt" | "updatedAt"
>;

/**
 * The instructions reduced to exactly the fields a snapshot preserves.
 *
 * `satisfies` is what does the work: the object must cover every evidence field, so the build fails
 * if one is added upstream and not handled here.
 */
export const toInstructionSnapshotValues = (instructions: InstitutionPaymentInstructionsRecord) =>
  ({
    bankName: instructions.bankName,
    accountNumber: instructions.accountNumber,
    accountHolderName: instructions.accountHolderName,
    qrisR2Key: instructions.qrisR2Key,
    instructionsNote: instructions.instructionsNote,
  }) satisfies Record<InstructionEvidenceField, string | null>;

/**
 * Whether this institution can be paid on the manual lane at all.
 *
 * ABSENCE IS THE INCOMPLETE STATE. A database CHECK refuses a row naming neither a bank account nor
 * a QRIS, so any row that exists is payable by construction and there is no half-filled state to
 * interpret, which is why this asks whether a row exists rather than counting populated columns.
 *
 * This is the precondition on enabling a registration fee. Charging without it produces a candidate
 * who owes money and has nowhere to send it: the transfer goes directly to the institution, so if
 * the platform cannot name an account, nobody can.
 */
export const hasPaymentInstructions = async (
  institutionId: string,
  db: Database = getDb(),
): Promise<boolean> => (await loadPaymentInstructionsForInstitution(institutionId, db)) !== null;

/**
 * The instructions an institution must have before money can be taken in its name, or a refusal.
 *
 * Returns the row rather than a boolean because every caller needing the check also needs the
 * values, to snapshot them or to show them to the payer. Splitting the two would mean reading the
 * row twice and leaving a window in which the second read finds it gone.
 */
export const requirePaymentInstructions = async (
  institutionId: string,
  db: Database = getDb(),
): Promise<InstitutionPaymentInstructionsRecord> => {
  const instructions = await loadPaymentInstructionsForInstitution(institutionId, db);

  if (!instructions) {
    throw new PaymentInstructionsError(
      "payment_instructions_missing",
      "Institusi belum mengisi informasi pembayaran, sehingga belum dapat menerima pembayaran",
      409,
    );
  }

  return instructions;
};

export type SavePaymentInstructionsInput = {
  bankName: string | null;
  accountNumber: string | null;
  accountHolderName: string | null;
  qrisR2Key: string | null;
  instructionsNote: string | null;
};

/**
 * Creates or replaces an institution's payment instructions.
 *
 * UPSERT on the institution, because these are current contact details rather than a ledger: there
 * is one right answer to "where do we send money today", and keeping superseded account numbers
 * here would invite a reader to pick the wrong one. The history that does matter, what each
 * individual payer was told, is snapshotted onto their payment instead.
 */
export const savePaymentInstructions = async (
  institutionId: string,
  input: SavePaymentInstructionsInput,
  db: Database = getDb(),
  now: Date = new Date(),
): Promise<InstitutionPaymentInstructionsRecord> => {
  const bankName = normalizeOptional(input.bankName);
  const accountNumber = normalizeOptional(input.accountNumber);
  const accountHolderName = normalizeOptional(input.accountHolderName);
  const qrisR2Key = normalizeOptional(input.qrisR2Key);
  const instructionsNote = normalizeOptional(input.instructionsNote);

  if (qrisR2Key !== null) {
    assertQrisKeyBelongsToInstitution(qrisR2Key, institutionId);
  }

  const namesBankAccount =
    bankName !== null && accountNumber !== null && accountHolderName !== null;

  // Checked here as well as by the database CHECK so the organiser reads a sentence naming what is
  // missing, rather than a constraint violation surfaced as a generic write failure.
  if (qrisR2Key === null && !namesBankAccount) {
    throw new PaymentInstructionsError(
      "payment_instructions_incomplete",
      "Isi nama bank, nomor rekening, dan nama pemilik rekening, atau unggah QRIS",
    );
  }

  const [saved] = await db
    .insert(institutionPaymentInstructions)
    .values({
      institutionId,
      bankName,
      accountNumber,
      accountHolderName,
      qrisR2Key,
      instructionsNote,
    })
    .onConflictDoUpdate({
      target: institutionPaymentInstructions.institutionId,
      set: {
        bankName,
        accountNumber,
        accountHolderName,
        qrisR2Key,
        instructionsNote,
        updatedAt: now,
      },
    })
    .returning();

  if (!saved) {
    throw new Error("Payment instructions upsert returned no row");
  }

  return saved;
};

/** Blank and whitespace-only both mean "not provided"; the CHECK reads NULL, not emptiness. */
const normalizeOptional = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const QRIS_UPLOAD_EXPIRY_SECONDS = 5 * 60;

export type QrisUploadGrant = {
  uploadUrl: string;
  r2Key: string;
  contentType: QrisMimeType;
  expiresAt: Date;
};

/**
 * A short-lived URL for uploading this institution's QRIS image.
 *
 * THE KEY IS BUILT HERE AND NEVER ACCEPTED FROM THE CALLER. `assertQrisKeyBelongsToInstitution`
 * exists because `savePaymentInstructions` does take a key from a request body; this path removes
 * the question entirely by minting the only key the upload can write to. The two guards are not
 * redundant: a caller can still POST a key straight to save without ever asking for a grant.
 *
 * A FRESH KEY EVERY TIME, never a stable per-institution path. Snapshots taken for earlier payers
 * point at the object they were actually shown, so overwriting one key would rewrite what a payer
 * was told to scan months after they paid against it.
 */
export const generateQrisUploadUrl = async (
  institutionId: string,
  input: { fileName: string },
  now: Date = new Date(),
): Promise<QrisUploadGrant> => {
  const contentType = qrisMimeTypeForFileName(input.fileName);

  if (contentType === null) {
    throw new PaymentInstructionsError(
      "payment_instructions_qris_format_unsupported",
      `Format tidak didukung. Unggah QRIS dalam format ${QRIS_FORMAT_HINT}.`,
    );
  }

  if (!isR2Available()) {
    throw new PaymentInstructionsError(
      "payment_instructions_upload_unavailable",
      "Penyimpanan berkas belum dikonfigurasi sehingga unggahan QRIS sementara tidak tersedia",
      503,
    );
  }

  const r2Key = `${buildQrisObjectPrefix(institutionId)}${randomUUID()}`;
  const uploadUrl = await generatePresignedPutUrl(r2Key, contentType, QRIS_UPLOAD_EXPIRY_SECONDS);

  return {
    uploadUrl,
    r2Key,
    contentType,
    expiresAt: new Date(now.getTime() + QRIS_UPLOAD_EXPIRY_SECONDS * 1000),
  };
};
