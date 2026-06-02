import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import { ModerationError, toModerationErrorResponse } from "@/server/moderation/moderation-core";
import { addNote, listNotes } from "@/server/moderation/notes-service";

// Add an internal platform ops note targeting exactly one user OR institution. platform_ops only.
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireSessionRole(["platform_ops"]);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const raw = (body ?? {}) as {
      targetUserId?: unknown;
      targetInstitutionId?: unknown;
      note?: unknown;
    };

    const result = await addNote(session.user.id, {
      targetUserId: typeof raw.targetUserId === "string" ? raw.targetUserId : null,
      targetInstitutionId: typeof raw.targetInstitutionId === "string" ? raw.targetInstitutionId : null,
      note: typeof raw.note === "string" ? raw.note : "",
    });

    return NextResponse.json({ note: result }, { status: 200 });
  } catch (error) {
    if (error instanceof ModerationError) {
      return toModerationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}

// List notes for exactly one target (?targetUserId= or ?targetInstitutionId=). 400 if neither or
// both are provided (enforced by the service's single-target invariant). platform_ops only.
export async function GET(request: Request): Promise<Response> {
  try {
    await requireSessionRole(["platform_ops"]);

    const params = new URL(request.url).searchParams;
    const targetUserId = params.get("targetUserId");
    const targetInstitutionId = params.get("targetInstitutionId");

    const notes = await listNotes({ targetUserId, targetInstitutionId });
    return NextResponse.json({ notes }, { status: 200 });
  } catch (error) {
    if (error instanceof ModerationError) {
      return toModerationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
