import { InstitutionWorkspaceShell } from "@/components/institution/institution-workspace-shell";
import { getCurrentSession } from "@/server/auth/session";
import { redirect } from "next/navigation";

const INSTITUTION_CREATE_PATH = "/institution/create";

export default async function InstitutionCreatePage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(INSTITUTION_CREATE_PATH)}`);
  }

  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/auth/verify-role?as=recruiter");
  }

  return <InstitutionWorkspaceShell />;
}
