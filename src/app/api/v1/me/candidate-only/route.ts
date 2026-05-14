import { withApiRole } from "@/server/auth/api-guard";

// Rollback Step 1.3 minimal-proof surface — candidate-only gating proof.
// A candidate-only session receives 200; a recruiter-only session receives 403.
export const GET = withApiRole(["candidate"], async (_request, session) => {
  return Response.json({
    accessed: "candidate-only",
    userId: session.user.id,
    role: session.user.role,
  });
});
