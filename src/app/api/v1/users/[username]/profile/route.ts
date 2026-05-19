import { NextResponse } from "next/server";
import { getPublicProfile } from "@/server/user-profile/profile-service";

// GET /api/v1/users/[username]/profile
// Public endpoint — no auth required.
// Returns the profile for the given username. Scope-gated fields are omitted entirely
// (not emitted as null or with an indicator) — the public response is always clean.
// Returns 404 if no user with that username exists.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ username: string }> },
): Promise<Response> {
  const { username } = await params;
  const profile = await getPublicProfile(username);

  if (!profile) {
    return NextResponse.json(
      { error: { code: "profile_not_found", message: "No profile found for this username" } },
      { status: 404 },
    );
  }

  return NextResponse.json({ profile });
}
