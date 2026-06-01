import { NextResponse } from "next/server";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { ResultError, toResultErrorResponse, publishResult } from "@/server/participants/result-service";
import { enqueueResultPublished } from "@/server/async/enqueue";
import { logger } from "@/lib/logger";

type RouteContext = {
  params: Promise<{ institutionSlug: string; competitionId: string; registrationId: string }>;
};

// POST — transition result draft → published.
// Enqueues a result.published BullMQ job after commit; enqueue failure is logged but
// does not block the response (fire-and-forget per locked project rules).
export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId, registrationId } = await context.params;
    const db = getDb();
    const { institutionId, actorMembershipId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const { result, teamId } = await publishResult(institutionId, competitionId, registrationId, actorMembershipId, db);

    // Fire-and-forget notification trigger. Failure must not block the publish response.
    enqueueResultPublished({
      registrationId,
      competitionId,
      teamId: teamId ?? undefined,
    }).catch((err: unknown) => {
      logger.error("result.published.enqueue_failed", {
        registrationId,
        competitionId,
        teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ResultError) return toResultErrorResponse(error);
    return toAccessDeniedResponse(error);
  }
}
