import { assertServerOnly } from "@/server/runtime/assert-server-only";

assertServerOnly("server/teams/team-invitation-expiry");

import { and, eq, gt, inArray } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { teamInvitations, teams } from "@/server/db/schema";

type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

// Every open team invite expires at its competition's registration close. Runs in the transaction
// that moves the close, under the participation lock, so no open invite keeps the old close. An
// invite that already ended stays ended.
export const moveOpenTeamInvitationsToClose = async (
  tx: DbOrTx,
  competitionId: string,
  closesAt: Date,
  now: Date,
): Promise<void> => {
  const competitionTeamIds = tx
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.competitionId, competitionId));

  await tx
    .update(teamInvitations)
    .set({ expiresAt: closesAt })
    .where(
      and(
        inArray(teamInvitations.status, ["pending", "pending_claim"]),
        gt(teamInvitations.expiresAt, now),
        inArray(teamInvitations.teamId, competitionTeamIds),
      ),
    );
};
