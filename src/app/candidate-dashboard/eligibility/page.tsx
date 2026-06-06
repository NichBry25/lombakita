import { redirect } from "next/navigation";
import { sessionHasRole } from "@/lib/access/roles";
import { StudentEligibilityShell } from "@/components/student/student-eligibility-shell";
import { getCurrentSession } from "@/server/auth/session";

const ELIGIBILITY_PATH = "/candidate-dashboard/eligibility";

export default async function CandidateEligibilityPage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(ELIGIBILITY_PATH)}`);
  }

  if (!sessionHasRole(session.user.role, session.user.verifiedRoles, "candidate")) {
    redirect("/");
  }

  return <StudentEligibilityShell expectedUserId={session.user.id} />;
}
