import { sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";

type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

const COMPETITION_PARTICIPATION_LOCK_NAMESPACE = "competition_participation:";

// Serializes every mutation that can change a competition's participant-entry count with the
// organizer's terminal proceed/cancel decision. The lock is transaction-scoped and keyed by
// competition, so unrelated competitions never block one another.
//
// This closes the confirmation-boundary race: a registration or withdrawal that acquired the lock
// before the boundary commits before the decision counts entries; a mutation that acquires it after
// the decision must re-check the boundary and is refused.
export const acquireCompetitionParticipationLock = async (
  tx: TransactionClient,
  competitionId: string,
): Promise<void> => {
  const lockKey = `${COMPETITION_PARTICIPATION_LOCK_NAMESPACE}${competitionId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
};
