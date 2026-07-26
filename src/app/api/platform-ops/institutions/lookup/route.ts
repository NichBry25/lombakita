import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { lookupInstitutionBySlugOrName } from "@/server/moderation/lookup-service";

// Platform ops support lookup: resolve an institution by slug or display name. platform_ops only.
export async function GET(request: Request): Promise<Response> {
  try {
    await requireSessionRole(["platform_ops"]);

    const slug = new URL(request.url).searchParams.get("slug");
    if (typeof slug !== "string" || slug.trim().length === 0) {
      return NextResponse.json(
        { error: { code: "slug_required", message: "slug query parameter is required" } },
        { status: 400 },
      );
    }

    const result = await lookupInstitutionBySlugOrName(slug.trim());
    if (!result) {
      return NextResponse.json(
        {
          error: {
            code: "institution_not_found",
            message: "No institution matches that slug or name",
          },
        },
        { status: 404 },
      );
    }

    return NextResponse.json({ institution: result }, { status: 200 });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
