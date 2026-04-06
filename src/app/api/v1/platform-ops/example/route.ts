import { NextResponse } from "next/server";
import { withApiRole } from "@/server/auth/api-guard";

export const GET = withApiRole(["platform_ops"], async () => {
  return NextResponse.json({
    status: "ok",
    message: "Role guard baseline active for platform_ops routes.",
  });
});
