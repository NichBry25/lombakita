import { and, eq, or } from "drizzle-orm";
import { assertServerOnly } from "@/server/runtime/assert-server-only";
import {
  institutionInvitations,
  institutionMemberships,
  institutionVerificationSubmissions,
  users,
} from "@/server/db/schema";
import {
  OperatorActorError,
  type OperatorActorTransaction,
  type ResolvedPlatformOpsActor,
} from "@/server/platform-ops/operator-actor";
import { normalizeInviteEmail } from "@/server/invitations/claim-service";

assertServerOnly("server/institution-verification/operator-institution-conflict");

// NOBODY DECIDES AN INSTITUTION THEY ARE INSIDE, FILED FOR, OR WERE INVITED INTO.
//
// The rule is declared once here and called from both decision paths — `verifyInstitution`
// (verification-service.ts) and `reviewVerificationSubmission` (submission-service.ts) — because the
// three relationships below are properties of the (actor, institution) pair, not of the path. A
// second copy would drift the moment one side learned about a fourth relationship.
//
// ALL THREE ARMS ASK "ANY STATUS", and that is narrower than it looks. `isInstitutionMemberBySlug`
// (member-service.ts:168) answers a different question — whether the actor is an ACTIVE member with
// one of three roles — and is left alone: the exposure rule that consumes it wants exactly that.
// Here the question is whether a relationship EVER existed. A revoked membership, a declined
// invitation and a rejected submission are all still records that the deciding account was on the
// other side of the decision, and the audit row this refusal protects would read as independent
// either way.
//
// The invitation arm's email comparison is NOT re-derived. It is the comparison the claim-at-signup
// path uses to bind an email-addressed invitation to the account that owns that address
// (claim-service.ts:47), reached through that module's own normaliser.
export const OPERATOR_ACTOR_CONFLICTED_MESSAGE =
  "A platform-ops account cannot decide the verification of an institution it has filed for, been invited to, or held any membership in";

const refusal = (): OperatorActorError =>
  new OperatorActorError("operator_actor_conflicted", 403, OPERATOR_ACTOR_CONFLICTED_MESSAGE);

/**
 * Refuse unless the actor has no relationship to this institution.
 *
 * Takes an institution ID rather than a slug: all three tables key on `institution_id`, and a slug is
 * a presentation value that a caller had to read a row to obtain. Every read runs against `tx`, so a
 * caller that resolved the actor in this transaction and calls this before its first write gets the
 * whole rule inside the same snapshot.
 */
export const assertOperatorHasNoInstitutionRelationship = async (
  tx: OperatorActorTransaction,
  actor: ResolvedPlatformOpsActor,
  institutionId: string,
): Promise<void> => {
  const [membership] = await tx
    .select({ id: institutionMemberships.id })
    .from(institutionMemberships)
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.userId, actor.userId),
      ),
    )
    .limit(1);

  if (membership) throw refusal();

  const [filed] = await tx
    .select({ id: institutionVerificationSubmissions.id })
    .from(institutionVerificationSubmissions)
    .where(
      and(
        eq(institutionVerificationSubmissions.institutionId, institutionId),
        eq(institutionVerificationSubmissions.submittedByUserId, actor.userId),
      ),
    )
    .limit(1);

  if (filed) throw refusal();

  const [account] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);

  // Unreachable while the actor came from `resolvePlatformOpsActor` in this same transaction, which
  // reads this row before returning. Refused rather than skipped: an email arm that silently drops
  // is an invitation the actor is allowed to decide, and this is the one arm whose input is not
  // already on hand.
  if (!account) {
    throw new OperatorActorError(
      "operator_actor_not_found",
      403,
      "The acting account was not found",
    );
  }

  const [invited] = await tx
    .select({ id: institutionInvitations.id })
    .from(institutionInvitations)
    .where(
      and(
        eq(institutionInvitations.institutionId, institutionId),
        or(
          eq(institutionInvitations.targetUserId, actor.userId),
          eq(institutionInvitations.invitedEmail, normalizeInviteEmail(account.email)),
        ),
      ),
    )
    .limit(1);

  if (invited) throw refusal();
};
