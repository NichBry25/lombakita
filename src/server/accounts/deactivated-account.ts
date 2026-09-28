import { eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/accounts/deactivated-account");

// A Drizzle transaction handle. The status read is only meaningful inside the transaction that
// performs the write it guards: read outside it, the answer is one a concurrent de-identification
// can invalidate before the write lands.
type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

// The refusal every operator action against a de-identified account carries. One code and one
// message, so an operator who meets it on one console recognises it on the next.
export const ACCOUNT_DEACTIVATED_CODE = "account_deactivated";
export const ACCOUNT_DEACTIVATED_MESSAGE =
  "Data akun ini sudah dihapus. Tindakan ini tidak tersedia.";

// The shape of the error class each caller already answers a 409 with. Passed as the class itself
// rather than thrown from here: `ModerationError` and `RecruiterTierElevationError` are the two
// vocabularies in play, and a guard that picked one would be invisible to whichever route does not
// catch it.
type DeactivatedRefusal = new (code: "account_deactivated", status: 409, message: string) => Error;

/**
 * Refuse an operator action whose target has been de-identified.
 *
 * `deactivated` means gone: the account's own rows are removed, its files are deleted, and the
 * tombstone row that survives carries no name, address or username. Every operator write that names
 * such a row as its subject is acting on something the person is no longer reachable through, which
 * is why the refusal sits in the writing transaction of each caller rather than at the route.
 */
export const assertAccountNotDeactivated = async (
  tx: TransactionClient,
  userId: string,
  Refusal: DeactivatedRefusal,
): Promise<void> => {
  const [row] = await tx
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (row?.status === "deactivated") {
    throw new Refusal(ACCOUNT_DEACTIVATED_CODE, 409, ACCOUNT_DEACTIVATED_MESSAGE);
  }
};
