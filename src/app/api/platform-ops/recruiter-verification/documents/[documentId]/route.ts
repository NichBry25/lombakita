import { NextResponse } from "next/server";
import { toAccessDeniedResponse } from "@/server/auth/access-core";
import { requireSessionRole } from "@/server/auth/session";
import {
  RecruiterVerificationError,
  toRecruiterVerificationErrorResponse,
} from "@/server/recruiter-verification/recruiter-verification-core";
import { resolveVerificationDocumentUrlForOps } from "@/server/recruiter-verification/recruiter-verification-service";

type RouteContext = { params: Promise<{ documentId: string }> };

// GET — platform-ops read access to a recruiter's affiliation document. Returns a short-lived
// presigned URL. `?disposition=inline` (default) views the file in a browser tab; `attachment`
// downloads it as `<username>_verification_<original name>`. platform_ops only.
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    await requireSessionRole(["platform_ops"]);
    const { documentId } = await context.params;

    const dispositionParam = new URL(request.url).searchParams.get("disposition");
    const disposition = dispositionParam === "attachment" ? "attachment" : "inline";

    const result = await resolveVerificationDocumentUrlForOps(documentId, disposition);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RecruiterVerificationError) {
      return toRecruiterVerificationErrorResponse(error);
    }
    return toAccessDeniedResponse(error);
  }
}
