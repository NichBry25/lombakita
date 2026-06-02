import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { lookupUserByEmail } from "@/server/moderation/lookup-service";

// Platform ops support lookup: resolve a user by email (case-insensitive). platform_ops only.
export async function GET(request: Request): Promise<Response> {
  try {
    await requireSessionRole(["platform_ops"]);

    const email = new URL(request.url).searchParams.get("email");
    if (typeof email !== "string" || email.trim().length === 0) {
      return NextResponse.json(
        { error: { code: "email_required", message: "email query parameter is required" } },
        { status: 400 },
      );
    }

    const result = await lookupUserByEmail(email.trim());
    if (!result) {
      return NextResponse.json(
        { error: { code: "user_not_found", message: "No user matches that email" } },
        { status: 404 },
      );
    }

    return NextResponse.json({ user: result }, { status: 200 });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
