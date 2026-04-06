import { NextResponse } from "next/server";
import { buildAccessContext } from "@/server/auth/access-core";
import { withApiAuth } from "@/server/auth/api-guard";

export const GET = withApiAuth(async (_request, session) => {
  return NextResponse.json({
    authenticated: true,
    user: {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
    },
    access: buildAccessContext(session),
  });
});
