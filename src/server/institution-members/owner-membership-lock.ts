import { sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";

// A Drizzle transaction handle — the argument db.transaction()'s callback receives. Like the
// owner-cap lock, this is only meaningful inside a transaction: pg_advisory_xact_lock is
// transaction-scoped and is released automatically when the transaction commits or rolls back.
type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Namespace prefix for the per-institution advisory-lock key. Distinct institutions produce distinct
// keys, so the lock serializes only operations on the same institution.
const OWNER_MEMBERSHIP_LOCK_NAMESPACE = "inst_owner_membership:";

/**
 * Serializes the operations that can change who an institution's active owners are, for the life of
 * `tx`.
 *
 * Why this exists: the last-owner rules are counts. `changeMemberRole` and `removeMember` refuse to
 * take an institution's active owner count to zero, and `deidentifyAccount` refuses to revoke the
 * last one — each by COUNTING the institution's active owners and refusing on the answer. Under
 * READ COMMITTED that count is a phantom-vulnerable predicate across DIFFERENT rows: two concurrent
 * transactions each take a snapshot that cannot see the other's uncommitted change to a different
 * membership row, so both count two owners, both pass, and both proceed — leaving an institution
 * with no active owner, which nothing in the product can repair. The count ranges over other rows,
 * so no single-row compare-and-set can express it.
 *
 * Pooling safety and key construction are the owner-cap lock's, deliberately: pg_advisory_xact_lock
 * rather than the session variant, because Neon's pooled endpoint runs PgBouncer in transaction mode
 * and the lock must be acquired and released on one backend. Key:
 * hashtext('inst_owner_membership:' || institutionId), the same single-argument call form
 * `acquireOwnerCapLock` uses. hashtext can collide across the int4 space; a collision only makes two
 * unrelated institutions briefly serialize, which is false contention and never a wrong count.
 *
 * Ordered by id, and that ordering is load-bearing rather than cosmetic: an operation that holds
 * several institution locks at once takes them in the same order as every other such operation, so
 * two of them cannot deadlock against each other.
 *
 * Must be called inside a db.transaction(), before the count it protects, in the same transaction as
 * the mutation that count guards.
 */
export const lockInstitutionOwnership = async (
  tx: TransactionClient,
  institutionIds: readonly string[],
): Promise<void> => {
  const ascending = [...new Set(institutionIds)].sort();

  for (const institutionId of ascending) {
    const lockKey = `${OWNER_MEMBERSHIP_LOCK_NAMESPACE}${institutionId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
  }
};
