import { NextRequest, NextResponse } from "next/server";
import { buildHealthPayload } from "@/server/health";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const probeMode = request.nextUrl.searchParams.get("probe");
  const includeLiveChecks = probeMode === "live";

  return NextResponse.json(await buildHealthPayload({ includeLiveChecks }), {
    status: 200,
  });
}
