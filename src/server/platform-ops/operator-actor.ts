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
 * refused. The constructor freezes, so a live actor cannot be mutated into a different claim.
 *
 * THE COMPILER HALF DOES NOT COVER THE RUNTIME. `recordOperatorAuditEntry` gates on membership of
 * `genuineOperatorActors` rather than on `instanceof`, and the difference is measured rather than
 * argued: `instanceof` is satisfied by anything whose prototype chain reaches this class, and three
 * ways of producing one never run resolvePlatformOpsActor — `Object.create`,
 * `new real.constructor(...)`, and `Object.setPrototypeOf`. See the set's own docstring.
 *
 * THE CLASS ITSELF IS NOT EXPORTED — only its type is, on the line below. So `new
 * ResolvedPlatformOpsActor(...)` has no spelling outside this module. What that buys is narrower
 * than "the only value of this type in existence came out of `resolvePlatformOpsActor`", which the
 * earlier wording here claimed and which is false: an object of this type can be built outside by
 * reaching the prototype through a live instance, and `constructor` is an ordinary property of one.
 * What is true is that constructing such an object does not register it, and the registration is
 * what the insert requires.
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
 * The actors this module has resolved, held by identity rather than by shape.
 *
 * WHY A `WeakSet` AND NOT `instanceof`. `instanceof` asks a question about the PROTOTYPE CHAIN, and
 * the prototype chain is an ordinary, writable property that any caller can assemble without ever
 * running the constructor. Three routes were measured against an `instanceof` gate and all three
 * passed it: `Object.create(real.constructor.prototype)`, `new real.constructor("attacker")` — the
 * constructor is reachable as a property of any live instance even though the class is not exported
 * — and `Object.setPrototypeOf({ userId: "attacker" }, Object.getPrototypeOf(real))`. A `WeakSet`
 * asks a question about IDENTITY instead: it holds the exact objects added to it and nothing that
 * merely resembles one, so none of those three is a member and no fourth spelling of the same idea
 * is either.
 *
 * MODULE-PRIVATE AND DELIBERATELY NOT EXPORTED. A set the caller can reach is a set the caller can
 * add to, which would return the gate to being a claim. The only code that can add to it is the one
 * function below, and it adds only what it built itself.
 *
 * WHY `WeakSet` RATHER THAN `Set`: membership is the only question ever asked, and the actors are
 * short-lived. A strong set would retain every actor ever resolved for the life of the process and
 * turn this guard into a memory leak proportional to traffic.
 */
const genuineOperatorActors = new WeakSet<ResolvedPlatformOpsActor>();

/**
 * A transaction handle, and specifically not the pool.
 *
 * `Database` has no `rollback`, so it is not assignable here and `resolvePlatformOpsActor(db, id)`
 * does not compile. What that buys is narrow: the actor is readable only from inside SOME
 * transaction, and the type does not say which one. `recordOperatorAuditEntry(tx, actor, entry)`
 * never checks that `actor` was resolved in `tx` — it checks membership in the set
 * `resolvePlatformOpsActor` registers into, and an actor resolved in a DIFFERENT transaction is a
 * member of that set too.
 *
 * THE STRONGER CLAIM IS NOT TRUE, and an earlier version of this docstring made it: this type does
 * not make "read the actor in the same transaction that writes the audit row" a property of the
 * code. What holds today is that `elevateRecruiterTier` resolves and writes inside one callback,
 * which is a convention at a single call site — nothing refuses an actor resolved in one
 * transaction and handed to another. The race the convention closes is real, because a resolution
 * taken outside the writing transaction is one an account suspension can overtake, so a second call
 * site has to keep the convention by hand rather than inherit it from the type.
 */
export type OperatorActorTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type OperatorActorRefusalCode =
  | "operator_actor_not_found"
  | "operator_actor_not_platform_ops"
  | "operator_actor_suspended"
  | "operator_actor_is_target"
  // The actor may act as platform ops, but not on THIS target: they are inside it, or they filed
  // for it. Distinct from `is_target`, which is about the actor's own account row; this is about a
  // relationship between the actor and the thing being decided. Raised by the institution
  // verification paths — see `verification-service.ts` and `submission-service.ts`.
  | "operator_actor_conflicted";

/**
 * One status for every refusal in this family.
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

  const actor = new ResolvedPlatformOpsActor(row.id);

  // Registered HERE, never in the constructor. A constructor that registered its own product would
  // make any construction a resolution, and the class is reachable as `real.constructor` from every
  // live instance — so the constructor would hand the attacker the very membership this exists to
  // withhold.
  genuineOperatorActors.add(actor);

  return actor;
};

/**
 * Everything a `platform_ops_audit_logs` row carries except who did it.
 *
 * Derived from the table rather than restated, so a column added to the audit log arrives here
 * without an edit — and, IF THAT COLUMN IS `NOT NULL` WITH NO DEFAULT, the compiler names every call
 * site that has not been taught to fill it. The condition is the whole of the claim: a nullable or
 * defaulted column is optional in `$inferInsert`, so adding one changes nothing at any call site and
 * rows written afterwards carry whatever the default says. The earlier wording here stated the
 * consequence unconditionally, which was true only of the NOT NULL case.
 */
export type OperatorAuditEntry = Omit<typeof platformOpsAuditLogs.$inferInsert, "actorUserId">;

/**
 * Write one audit row, naming an actor the database has confirmed.
 *
 * The `actor` parameter is the enforcement: there is no overload taking a string, so the only way
 * to reach this insert is to have called `resolvePlatformOpsActor` first. A caller that skips the
 * resolution does not get an unchecked row — it gets a type error.
 *
 * The membership check is the second half, and it is not redundant with the type. The type stops a
 * caller who is reading the compiler; it does not stop a value that arrived through a cast, an
 * `any` from `JSON.parse`, or a spread written by someone who did not read this file.
 *
 * ONLY WHAT `resolvePlatformOpsActor` REGISTERED REACHES THE INSERT — measured, not asserted. Seven
 * routes that produce something of this type without calling that function were run against this
 * gate, and each throws here instead of writing: a spread of a live actor, `structuredClone`,
 * `Object.assign`, `JSON.parse`, `Object.create`, `new real.constructor(...)`, and
 * `Object.setPrototypeOf`. The three prototype-chain routes are the ones an `instanceof` gate did
 * NOT stop, which is why the gate is membership rather than `instanceof`.
 */
export const recordOperatorAuditEntry = async (
  tx: OperatorActorTransaction,
  actor: ResolvedPlatformOpsActor,
  entry: OperatorAuditEntry,
): Promise<void> => {
  if (!genuineOperatorActors.has(actor)) {
    throw new Error(
      "recordOperatorAuditEntry was given an actor that resolvePlatformOpsActor did not produce, " +
        "so the id it carries is a claim rather than a database answer",
    );
  }

  await tx.insert(platformOpsAuditLogs).values({ ...entry, actorUserId: actor.userId });
};
