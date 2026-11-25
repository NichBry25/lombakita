import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/server/db/client";
import { institutionMemberships, users } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/host-trust/publish-trust");

// True when an active institution_owner of the institution is a trusted host whose account is active and not suspended.
const institutionHasTrustedOwner = async (
  institutionId: string,
  db: Database,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: institutionMemberships.id })
    .from(institutionMemberships)
    .innerJoin(users, eq(users.id, institutionMemberships.userId))
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.membershipRole, "institution_owner"),
        eq(institutionMemberships.status, "active"),
        eq(users.recruiterVerificationTier, "elevated"),
        eq(users.status, "active"),
        isNull(users.suspendedAt),
      ),
    )
    .limit(1);

  return row !== undefined;
};

// Does not check that the actor belongs to the institution. Callers run assertCompetitionAccess
// first and pass the institution id of the competition row it loaded. An actor whose account is not
// active, or is suspended, publishes on no one's trust: a staff approval publishes as the host
// outside the host's own session, where no session check stops such an account.
export const isPublishTrustSatisfied = async (
  actorUserId: string,
  institutionId: string,
  db: Database = getDb(),
): Promise<boolean> => {
  const [actor] = await db
    .select({
      tier: users.recruiterVerificationTier,
      hostTrustRemovedAt: users.hostTrustRemovedAt,
      status: users.status,
      suspendedAt: users.suspendedAt,
    })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  if (!actor) return false;

  if (actor.status !== "active" || actor.suspendedAt !== null) return false;
  if (actor.tier === "elevated") return true;
  if (actor.hostTrustRemovedAt !== null) return false;
  return institutionHasTrustedOwner(institutionId, db);
};
