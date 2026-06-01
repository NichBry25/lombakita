import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import {
  ExportOwnershipError,
  exportRegistrantsAsCsv,
} from "@/server/participants/export-service";

type RouteContext = {
  params: Promise<{ institutionSlug: string; competitionId: string }>;
};

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug, competitionId } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const csv = await exportRegistrantsAsCsv(institutionId, competitionId, db);
    const date = new Date().toISOString().slice(0, 10);

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="registrants-${competitionId}-${date}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof ExportOwnershipError) {
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    }
    return toAccessDeniedResponse(error);
  }
}
