import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institutions/payment-instructions-service");

import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import {
  competitions,
  institutionPaymentInstructions,
  type InstitutionPaymentInstructionsRecord,
} from "@/server/db/schema";

// WHERE AN INSTITUTION WANTS TO BE PAID on the manual lane. READS ONLY in this step — the editing
// form is 7.2-MANUAL.2, and there is deliberately no write function here for it to call yet.
//
// Institution-level and reused across every competition the institution runs. There is no
// per-competition override, on purpose: an organiser maintaining one copy of its bank details per
// competition is how a closed account keeps collecting nobody's money for a year.
//
// These are the INSTITUTION'S OWN account details, shown to a payer so they can transfer directly.
// The platform never holds the funds (DEC-0130), which is exactly why it has to publish somebody
// else's account number.

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
 * Null means the institution has not configured any instructions — a real state a paid competition
 * must not be allowed to reach, and one the 7.2-MANUAL.2 checkout surface is responsible for
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
    .where(eq(competitions.id, competitionId))
    .limit(1);

  return row?.instructions ?? null;
};
