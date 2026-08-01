import { InstitutionWorkspaceShell } from "@/components/institution/institution-workspace-shell";
import { requireRolePage } from "@/server/auth/page-guard";

const INSTITUTION_CREATE_PATH = "/institution/create";

export default async function InstitutionCreatePage() {
  await requireRolePage("recruiter", {
    callbackPath: INSTITUTION_CREATE_PATH,
    missingRoleRedirect: "/auth/verify-role?as=recruiter",
  });

  return <InstitutionWorkspaceShell />;
}
