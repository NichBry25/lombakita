import { redirect } from "next/navigation";
import { DEFAULT_APP_ROLE, isAppRole } from "@/lib/access/roles";
import { StudentEligibilityShell } from "@/components/student/student-eligibility-shell";
import { getCurrentSession } from "@/server/auth/session";

const ELIGIBILITY_PATH = "/candidate-dashboard/eligibility";

export default async function CandidateEligibilityPage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(ELIGIBILITY_PATH)}`);
  }

  const normalizedRole = isAppRole(session.user.role) ? session.user.role : DEFAULT_APP_ROLE;

  if (normalizedRole !== "candidate") {
    redirect("/");
  }

  return <StudentEligibilityShell expectedUserId={session.user.id} />;
}
