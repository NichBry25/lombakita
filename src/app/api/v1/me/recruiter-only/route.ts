import { withApiRole } from "@/server/auth/api-guard";

// Minimal-proof surface — recruiter-only gating proof.
// A recruiter-only session receives 200; a candidate-only session receives 403.
export const GET = withApiRole(["recruiter"], async (_request, session) => {
  return Response.json({
    accessed: "recruiter-only",
    userId: session.user.id,
    role: session.user.role,
  });
});
