import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { institutionMemberships } from "@/server/db/schema";
import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/institution-members/owner-count");

type TransactionClient = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * How many active `institution_owner` memberships an institution has.
 *
 * The one definition of that count. An institution with zero of them is unadministrable — nobody can
 * publish, invite or change anything — so both callers refuse on it: `changeMemberRole` when a
 * demotion would take the last one away, and `reinstateInstitution` when a suspended institution
 * has nobody left to run it. A second copy of this query is a second answer to a question where a
 * wrong one strands an institution.
 *
 * Counted in SQL rather than by fetching the rows: the number is all either caller needs, and the
 * rows carry a user id neither of them reads.
 */
export const countActiveOwners = async (
  tx: TransactionClient,
  institutionId: string,
): Promise<number> => {
  const [row] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(institutionMemberships)
    .where(
      and(
        eq(institutionMemberships.institutionId, institutionId),
        eq(institutionMemberships.membershipRole, "institution_owner"),
        eq(institutionMemberships.status, "active"),
      ),
    );

  return row?.total ?? 0;
};
