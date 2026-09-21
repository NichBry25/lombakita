import { eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { platformOpsAuditLogs, users } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/platform-ops/operator-actor");

// Who is performing a platform-ops action, answered by the database (LAUNCH-D72).
//
// Every platform-ops audit row names an actor — `platform_ops_audit_logs.actor_user_id`, NOT NULL,
// an FK to `users.id` — and the FK is the whole of what the schema checks. It proves the id exists.
// It does not prove the account holds `platform_ops`, and it does not prove the account is
// unsuspended. So a service that accepts `actorUserId: string` and inserts it records a CLAIM as
// fact: a caller reaching that service off-route can write any id it likes, and nothing
// afterwards distinguishes that row from a real one.
//
// The fix is not a check but a shape, and what it covers is THIS PATH ONLY.
// `resolvePlatformOpsActor` is the only producer of `ResolvedPlatformOpsActor`, and
// `recordOperatorAuditEntry` is the only writer of a `platform_ops_audit_logs` row that accepts one
// — so a row naming an unresolved actor is not a call that returns early, it is a call that does
// not compile.
//
// IT DOES NOT COVER THE OTHER FOURTEEN, and the difference matters to whoever reads this next.
// Fourteen further inserts into `platform_ops_audit_logs` across nine modules take an unvalidated
// `actorUserId: string` and write it straight through — among them `suspendUser` (four sites in
// `src/server/moderation/moderation-service.ts`, and a more consequential action than a tier
// elevation) and `src/server/finance/dispute-view.ts:265`, which is not inside a transaction at
// all. Every one compiles today. Threading a resolved actor through those writers is future work;
// this module is a shape improvement on one path, not yet a property of the codebase.

/**
 * An actor the database has confirmed exists, holds `platform_ops`, and is not suspended.
 *
 * A CLASS WITH A PRIVATE MEMBER, not a branded object type, and the difference is the whole point.
 * A non-exported `unique symbol` used as a computed key stops the key being NAMED, but it does not
 * stop the type being COPIED: `{ ...real, userId: "attacker" }` carries the symbol through a spread
 * and compiles with no cast. TypeScript treats a private member as part of the type's identity
 * rather than its structure, so that spread — and every other object built outside this class — is
 * refused. `recordOperatorAuditEntry` additionally gates on `instanceof`, and the constructor
 * freezes, so the copy routes that defeat the compiler do not survive the runtime either.
 *
 * THE CLASS ITSELF IS NOT EXPORTED — only its type is, on the line below. So `new
 * ResolvedPlatformOpsActor(...)` has no spelling outside this module either, and the only value of
 * this type in existence came out of `resolvePlatformOpsActor`. That is a property of the compiler
 * rather than a sentence beside the code.
 */
class ResolvedPlatformOpsActor {
  readonly userId: string;

  /** Never read. Its presence is what makes every other object in the program unassignable here. */
  private readonly resolvedByDatabase = true;

  constructor(userId: string) {
    this.userId = userId;
    Object.freeze(this);
  }
}

export type { ResolvedPlatformOpsActor };

/**
 * A transaction handle, and specifically not the pool.
 *
 * `Database` has no `rollback`, so it is not assignable here and `resolvePlatformOpsActor(db, id)`
 * does not compile. That is the point: the actor is readable only from inside a transaction, which
 * is what makes "read the actor in the same transaction that writes the audit row" a property of
 * the code rather than a note beside it. A resolution taken outside the transaction races the write
 * it authorises — an account suspended between the two would elevate on a stale answer.
 */
export type OperatorActorTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type OperatorActorRefusalCode =
  | "operator_actor_not_found"
  | "operator_actor_not_platform_ops"
  | "operator_actor_suspended";

/**
 * One status for all three refusals.
 *
 * Deliberately not `404` for a missing account: the caller has just failed an authorization check,
 * and a status that distinguishes "no such user" from "wrong role" answers a question it was not
 * authorised to ask. This is the same answer `requireSessionRole(["platform_ops"])` already gives
 * this class of failure at the route, so a service reached off-route fails the way the route does
 * rather than inventing a second vocabulary for it.
 */
export class OperatorActorError extends Error {
  constructor(
    public readonly code: OperatorActorRefusalCode,
    public readonly status: 403,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Read the acting account, and refuse unless the database says it may act.
 *
 * `actorUserId` is whatever the caller claimed. It is not trusted, not echoed back, and not written
 * anywhere — the value returned carries the id the DATABASE answered with, so a caller that passes
 * a differently-cased or differently-resolved claim gets the stored one or a refusal.
 */
export const resolvePlatformOpsActor = async (
  tx: OperatorActorTransaction,
  actorUserId: string,
): Promise<ResolvedPlatformOpsActor> => {
  const [row] = await tx
    .select({ id: users.id, role: users.role, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);

  if (row === undefined) {
    throw new OperatorActorError(
      "operator_actor_not_found",
      403,
      "The acting account was not found",
    );
  }

  if (row.role !== "platform_ops") {
    throw new OperatorActorError(
      "operator_actor_not_platform_ops",
      403,
      "The acting account does not hold the platform_ops role",
    );
  }

  if (row.suspendedAt !== null) {
    throw new OperatorActorError(
      "operator_actor_suspended",
      403,
      "The acting account is suspended and cannot perform platform-ops actions",
    );
  }

  return new ResolvedPlatformOpsActor(row.id);
};

/**
 * Everything a `platform_ops_audit_logs` row carries except who did it.
 *
 * Derived from the table rather than restated, so a column added to the audit log is a field this
 * type requires at every call site instead of a column rows silently stop filling.
 */
export type OperatorAuditEntry = Omit<typeof platformOpsAuditLogs.$inferInsert, "actorUserId">;

/**
 * Write one audit row, naming an actor the database has confirmed.
 *
 * The `actor` parameter is the enforcement: there is no overload taking a string, so the only way
 * to reach this insert is to have called `resolvePlatformOpsActor` first. A caller that skips the
 * resolution does not get an unchecked row — it gets a type error.
 *
 * The `instanceof` is the second half, and it is not redundant with the type. The type stops a
 * caller who is reading the compiler; it does not stop a value that arrived through a cast, an
 * `any` from `JSON.parse`, or a spread written by someone who did not read this file. Only objects
 * this class constructed reach the insert.
 */
export const recordOperatorAuditEntry = async (
  tx: OperatorActorTransaction,
  actor: ResolvedPlatformOpsActor,
  entry: OperatorAuditEntry,
): Promise<void> => {
  if (!(actor instanceof ResolvedPlatformOpsActor)) {
    throw new Error(
      "recordOperatorAuditEntry was given an actor that resolvePlatformOpsActor did not produce, " +
        "so the id it carries is a claim rather than a database answer",
    );
  }

  await tx.insert(platformOpsAuditLogs).values({ ...entry, actorUserId: actor.userId });
};
