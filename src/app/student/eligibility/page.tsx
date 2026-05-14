import { redirect } from "next/navigation";
import { DEFAULT_APP_ROLE, isAppRole } from "@/lib/access/roles";
import { StudentEligibilityShell } from "@/components/student/student-eligibility-shell";
import { getCurrentSession } from "@/server/auth/session";

const STUDENT_ELIGIBILITY_PATH = "/student/eligibility";

export default async function StudentEligibilityPage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(STUDENT_ELIGIBILITY_PATH)}`);
  }

  const normalizedRole = isAppRole(session.user.role) ? session.user.role : DEFAULT_APP_ROLE;

  if (normalizedRole !== "candidate") {
    redirect("/");
  }

  return <StudentEligibilityShell />;
}
