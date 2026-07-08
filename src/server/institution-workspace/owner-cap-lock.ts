import { sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";

// A Drizzle transaction handle — the argument db.transaction()'s callback receives. The owner-cap
// lock is only meaningful inside a transaction: pg_advisory_xact_lock is transaction-scoped and is
// released automatically when the transaction commits or rolls back.
type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Namespace prefix for the per-owner advisory-lock key. Distinct owners produce distinct keys, so the
// lock serializes only same-owner operations and never blocks one recruiter behind another.
const OWNER_CAP_LOCK_NAMESPACE = "inst_owner_cap:";

// Serializes the cap-guarded institution mutations of a single owner for the life of `tx`.
//
// Why this exists: the per-recruiter institution caps (full: MAX_INSTITUTIONS_PER_RECRUITER;
// personal: MAX_PERSONAL_INSTITUTIONS_PER_RECRUITER) are enforced by COUNTING the owner's existing
// institutions and refusing the mutation at the cap. Under READ COMMITTED that count is a
// phantom-vulnerable predicate: two concurrent same-owner transactions each take a snapshot that
// cannot see the other's uncommitted insert (create paths) or type-flip (approval path), so both
// pass the count and the cap is exceeded. The count ranges over OTHER rows, so neither the
// create-path INSERT nor an approval-path row CAS has a single shared row to serialize on — the
// house WHERE-clause row CAS (transitionCompetitionStatus) cannot express a cross-row cap. A
// transaction-scoped advisory lock keyed on the owner is the serialization point: same-owner
// transactions run one at a time, so the count taken after the lock is acquired sees every
// previously-committed same-owner mutation.
//
// Pooling safety: this is pg_advisory_xact_lock (transaction-scoped), acquired and released within a
// single db.transaction(). Neon's pooled endpoint runs PgBouncer in transaction mode, which pins a
// transaction to one backend for its whole lifetime, so the lock is acquired and released on the same
// backend and is pooling-safe. The SESSION-scoped variant would not be — it could be acquired on one
// pooled backend and never released on another. Do not switch to the session variant.
//
// Key: hashtext('inst_owner_cap:' || userId) -> int4, widened to bigint for the single-argument
// overload. hashtext can collide across the int4 space; a collision only makes two unrelated owners
// briefly serialize (false contention, never a wrong cap) and is acceptable at MVP scale.
//
// Must be called inside a db.transaction(), before the cap count, in the same transaction as the
// mutation it guards.
export const acquireOwnerCapLock = async (
  tx: TransactionClient,
  userId: string,
): Promise<void> => {
  const lockKey = `${OWNER_CAP_LOCK_NAMESPACE}${userId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
};
