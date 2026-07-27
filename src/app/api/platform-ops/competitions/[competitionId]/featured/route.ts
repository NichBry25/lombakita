import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  setFeaturedPlacement,
  FeaturedPlacementError,
  toFeaturedPlacementErrorResponse,
} from "@/server/featured/featured-placement-service";

type RouteParams = { params: Promise<{ competitionId: string }> };

// Platform ops endpoint to set or unset featured placement on a published competition.
// Only platform_ops may call this. Competition must be status = 'published'.
// Setting isFeatured=false clears featuredOrder regardless of the submitted value.
// After a successful DB write, competition.search.sync is enqueued (fire-and-forget).
export async function PATCH(request: Request, { params }: RouteParams): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { competitionId } = await params;

    if (typeof competitionId !== "string" || competitionId.length === 0) {
      return NextResponse.json(
        { error: { code: "invalid_competition_id", message: "Competition id is required" } },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: "invalid_body", message: "Request body must be valid JSON" } },
        { status: 400 },
      );
    }

    if (typeof body !== "object" || body === null || !("isFeatured" in body)) {
      return NextResponse.json(
        { error: { code: "invalid_body", message: "isFeatured (boolean) is required" } },
        { status: 400 },
      );
    }

    const rawBody = body as Record<string, unknown>;
    if (typeof rawBody.isFeatured !== "boolean") {
      return NextResponse.json(
        { error: { code: "invalid_body", message: "isFeatured must be a boolean" } },
        { status: 400 },
      );
    }

    const rawOrder = rawBody.featuredOrder;
    let featuredOrder: number | null = null;
    if (rawOrder !== undefined && rawOrder !== null) {
      if (typeof rawOrder !== "number" || !Number.isInteger(rawOrder)) {
        return NextResponse.json(
          { error: { code: "invalid_body", message: "featuredOrder must be an integer or null" } },
          { status: 400 },
        );
      }
      featuredOrder = rawOrder;
    }

    const result = await setFeaturedPlacement(session.user.id, competitionId, {
      isFeatured: rawBody.isFeatured,
      featuredOrder,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof FeaturedPlacementError) {
      return NextResponse.json(toFeaturedPlacementErrorResponse(error), {
        status: error.status,
      });
    }
    return toAccessDeniedResponse(error);
  }
}
