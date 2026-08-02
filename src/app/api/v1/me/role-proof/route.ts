import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireAuthenticatedSession } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";

// Minimal-proof surface.
// Returns the authenticated user's user-level role and the per-role verification flags so the
// candidate-only vs recruiter-only state is visibly distinguishable from a browser tab or curl.
// The endpoint requires authentication; access-core.normalizeSessionRole rejects any session
// carrying a legacy/unknown role token with 401 (e.g. pre-rollback JWTs that slip past
// AUTH_SECRET rotation).
export async function GET(): Promise<Response> {
  try {
    const session = await requireAuthenticatedSession();
    const db = getDb();

    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        candidateVerifiedAt: users.candidateVerifiedAt,
        recruiterVerifiedAt: users.recruiterVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    if (!row) {
      return NextResponse.json(
        { error: { code: "user_not_found", message: "User row missing" } },
        { status: 404 },
      );
    }

    return NextResponse.json({
      session: {
        userId: session.user.id,
        role: session.user.role,
      },
      account: {
        role: row.role,
        candidateVerified: row.candidateVerifiedAt !== null,
        recruiterVerified: row.recruiterVerifiedAt !== null,
        candidateVerifiedAt: row.candidateVerifiedAt,
        recruiterVerifiedAt: row.recruiterVerifiedAt,
      },
    });
  } catch (error) {
    return toAccessDeniedResponse(error);
  }
}
