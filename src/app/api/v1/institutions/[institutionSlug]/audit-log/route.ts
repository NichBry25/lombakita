import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { requireAdminInstitutionBySlug } from "@/server/institution-members/member-service";
import { getDb } from "@/server/db/client";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { institutionAuditLogs, institutionMemberships, users } from "@/server/db/schema";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type RouteContext = {
  params: Promise<{ institutionSlug: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const { institutionSlug } = await context.params;
    const db = getDb();
    const { institutionId } = await requireAdminInstitutionBySlug(
      session.user.id,
      institutionSlug,
      db,
    );

    const url = new URL(request.url);
    const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
    const rawLimit = parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);

    const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
    const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
    const offset = (page - 1) * limit;

    const [events, countRows] = await Promise.all([
      db
        .select({
          id: institutionAuditLogs.id,
          eventType: institutionAuditLogs.action,
          actorName: users.name,
          metadata: institutionAuditLogs.metadata,
          createdAt: institutionAuditLogs.createdAt,
        })
        .from(institutionAuditLogs)
        .leftJoin(institutionMemberships, eq(institutionMemberships.id, institutionAuditLogs.targetMembershipId))
        .leftJoin(users, eq(users.id, institutionMemberships.userId))
        .where(eq(institutionAuditLogs.institutionId, institutionId))
        .orderBy(desc(institutionAuditLogs.createdAt))
        .limit(limit)
        .offset(offset),

      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(institutionAuditLogs)
        .where(eq(institutionAuditLogs.institutionId, institutionId)),
    ]);

    const total = countRows[0]?.count ?? 0;

    return NextResponse.json({ events, total, page, limit });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
