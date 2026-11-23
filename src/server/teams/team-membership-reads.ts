import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/team-membership-reads");

import { and, eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { teamMemberships } from "@/server/db/schema";

type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export const isActiveTeamMember = async (
  db: DbOrTx,
  teamId: string,
  userId: string,
): Promise<boolean> => {
  const [membership] = await db
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(teamMemberships.userId, userId),
        eq(teamMemberships.status, "active"),
      ),
    )
    .limit(1);

  return membership !== undefined;
};
