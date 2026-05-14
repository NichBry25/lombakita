import { DEFAULT_APP_ROLE, isAppRole } from "@/lib/access/roles";
import { StudentProfileShell } from "@/components/student/student-profile-shell";
import { getCurrentSession } from "@/server/auth/session";
import { redirect } from "next/navigation";

const STUDENT_PROFILE_PATH = "/student/profile";

export default async function StudentProfilePage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(STUDENT_PROFILE_PATH)}`);
  }

  const normalizedRole = isAppRole(session.user.role) ? session.user.role : DEFAULT_APP_ROLE;

  if (normalizedRole !== "candidate") {
    redirect("/");
  }

  return <StudentProfileShell />;
}
