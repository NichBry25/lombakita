import { NextResponse } from "next/server";
import { withApiRole } from "@/server/auth/api-guard";
import { listDocumentRequestsForCandidate } from "@/server/registration-documents/registration-document-service";

// Every document request addressed to the calling candidate, newest first. Scoped by
// registration.student_id, so another candidate's request is never reachable here.
export const GET = withApiRole(["candidate"], async (_request, session) => {
  const requests = await listDocumentRequestsForCandidate(session.user.id);
  return NextResponse.json({ requests });
});
