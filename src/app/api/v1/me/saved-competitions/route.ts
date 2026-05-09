import { withApiRole } from "@/server/auth/api-guard";
import { NextResponse } from "next/server";
import { listSavedCompetitions } from "@/server/saved-competitions/saved-competition-service";

export const GET = withApiRole(["student"], async (request, session) => {
  const url = new URL(request.url);
  const page = url.searchParams.has("page")
    ? Number.parseInt(url.searchParams.get("page")!, 10)
    : undefined;
  const limit = url.searchParams.has("limit")
    ? Number.parseInt(url.searchParams.get("limit")!, 10)
    : undefined;

  const result = await listSavedCompetitions(session.user.id, { page, limit });
  return NextResponse.json(result);
});
