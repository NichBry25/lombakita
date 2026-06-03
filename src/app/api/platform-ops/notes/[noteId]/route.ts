import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { ModerationError, toModerationErrorResponse } from "@/server/moderation/moderation-core";
import { editNote } from "@/server/moderation/notes-service";

type RouteContext = { params: Promise<{ noteId: string }> };

// In-place edit of a single platform ops note. platform_ops only.
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);
    const { noteId } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const raw = (body ?? {}) as { note?: unknown };
    const noteText = typeof raw.note === "string" ? raw.note : "";

    const result = await editNote(session.user.id, noteId, noteText);
    return NextResponse.json({ note: result }, { status: 200 });
  } catch (error) {
    if (error instanceof ModerationError) {
      return toModerationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
