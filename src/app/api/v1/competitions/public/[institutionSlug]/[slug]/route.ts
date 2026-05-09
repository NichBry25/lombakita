import { NextResponse, type NextRequest } from "next/server";
import { getPublicCompetitionDetail } from "@/server/competitions/competition-public-service";

type RouteContext = { params: Promise<{ institutionSlug: string; slug: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { institutionSlug, slug } = await context.params;
    const competition = await getPublicCompetitionDetail(institutionSlug, slug);

    if (!competition) {
      return NextResponse.json({ error: { code: "competition_not_found" } }, { status: 404 });
    }

    return NextResponse.json({ competition });
  } catch {
    return NextResponse.json({ error: { code: "internal_error" } }, { status: 500 });
  }
}
