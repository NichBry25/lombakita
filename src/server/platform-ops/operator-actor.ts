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
// `resolveOperatorActor` and its platform-ops wrapper produce `ResolvedPlatformOpsActor`, and
// `recordOperatorAuditEntry` is the only writer of a `platform_ops_audit_logs` row that accepts one
// — so a row naming an unresolved actor is not a call that returns early, it is a call that does
// not compile. At runtime the actor must belong to the transaction writing the audit row.
//
// Recruiter-tier elevation, account de-identification and the four moderation writers use this
// path. Ten further inserts still take an `actorUserId: string` directly, including the finance
// writers. Actor resolution is not yet a property of every audit writer in the codebase.

/**
 * An actor the database has confirmed exists, holds a required operator role, and is not suspended.
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
 * `new real.constructor(...)`, and `Object.setPrototypeOf`. See the map's own docstring.
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
 * The transaction that resolved each actor, keyed by actor identity rather than shape.
 *
 * WHY A `WeakMap` AND NOT `instanceof`. `instanceof` asks a question about the PROTOTYPE CHAIN, and
 * the prototype chain is an ordinary, writable property that any caller can assemble without ever
 * running the constructor. Three routes were measured against an `instanceof` gate and all three
 * passed it: `Object.create(real.constructor.prototype)`, `new real.constructor("attacker")` — the
 * constructor is reachable as a property of any live instance even though the class is not exported
 * — and `Object.setPrototypeOf({ userId: "attacker" }, Object.getPrototypeOf(real))`. A `WeakMap`
 * asks a question about IDENTITY instead: it holds the exact objects added to it and nothing that
 * merely resembles one, so none of those three is a member and no fourth spelling of the same idea
 * is either.
 *
 * MODULE-PRIVATE AND DELIBERATELY NOT EXPORTED. A map the caller can reach is a map the caller can
 * add to, which would return the gate to being a claim. The only code that can add to it is the one
 * function below, and it adds only what it built itself.
 *
 * The value binds the actor to the exact transaction object that resolved it (LAUNCH-D141),
 * including savepoint handles. Weak keys avoid retaining every actor and transaction for the
 * life of the process.
 */
const genuineOperatorActors = new WeakMap<ResolvedPlatformOpsActor, OperatorActorTransaction>();

/**
 * A transaction handle, and specifically not the pool.
 *
 * `Database` has no `rollback`, so it is not assignable here and `resolvePlatformOpsActor(db, id)`
 * does not compile. The type requires a transaction but cannot distinguish transaction objects.
 * `resolveOperatorActor` registers the resolving handle in the module-private WeakMap, and
 * `recordOperatorAuditEntry` checks that exact object before inserting. An actor passed into a
 * different transaction or savepoint is refused at runtime.
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
export const resolveOperatorActor = async (
  tx: OperatorActorTransaction,
  actorUserId: string,
  roles: readonly ("platform_ops" | "finance_ops")[],
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

  if (!roles.some((role) => role === row.role)) {
    throw new OperatorActorError(
      "operator_actor_not_platform_ops",
      403,
      `The acting account does not hold a required role: ${roles.join(" / ")}`,
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
  genuineOperatorActors.set(actor, tx);

  return actor;
};

export const resolvePlatformOpsActor = async (
  tx: OperatorActorTransaction,
  actorUserId: string,
): Promise<ResolvedPlatformOpsActor> => resolveOperatorActor(tx, actorUserId, ["platform_ops"]);

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
 * to reach this insert is to have called `resolveOperatorActor` or its wrapper first. A caller that skips the
 * resolution does not get an unchecked row — it gets a type error.
 *
 * The membership check is the second half, and it is not redundant with the type. The type stops a
 * caller who is reading the compiler; it does not stop a value that arrived through a cast, an
 * `any` from `JSON.parse`, or a spread written by someone who did not read this file.
 *
 * ONLY WHAT THE RESOLVER REGISTERED IN THIS TRANSACTION REACHES THE INSERT. Seven
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
  const resolvingTransaction = genuineOperatorActors.get(actor);

  if (resolvingTransaction === undefined) {
    throw new Error(
      "recordOperatorAuditEntry was given an actor that resolvePlatformOpsActor did not produce, " +
        "so the id it carries is a claim rather than a database answer",
    );
  }

  if (resolvingTransaction !== tx) {
    throw new Error(
      "recordOperatorAuditEntry was given an actor resolved in a different transaction",
    );
  }

  await tx.insert(platformOpsAuditLogs).values({ ...entry, actorUserId: actor.userId });
};
