import { InstitutionWorkspaceShell } from "@/components/institution/institution-workspace-shell";
import { getCurrentSession } from "@/server/auth/session";
import { redirect } from "next/navigation";

const INSTITUTION_WORKSPACE_PATH = "/institution/workspace";

export default async function InstitutionWorkspacePage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(INSTITUTION_WORKSPACE_PATH)}`);
  }

  if (session.user.role !== "recruiter") {
    redirect("/");
  }

  return <InstitutionWorkspaceShell />;
}
