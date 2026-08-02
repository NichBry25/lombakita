import { PersonalInstitutionCreateShell } from "@/components/institution/personal-institution-create-shell";
import { requireRolePage } from "@/server/auth/page-guard";
import { findOwnedPersonalInstitution } from "@/server/institution-workspace/institution-service";
import { redirect } from "next/navigation";

const PERSONAL_INSTITUTION_PATH = "/institution/personal";

// Minimal-proof create surface for a personal institution. Recruiter session
// required. The expected user id is rendered from the server-side session and threaded into the
// client shell for the Rule #16 cross-session guard.
export default async function PersonalInstitutionPage() {
  const session = await requireRolePage("recruiter", {
    callbackPath: PERSONAL_INSTITUTION_PATH,
  });

  const personalInstitution = await findOwnedPersonalInstitution(session.user.id);
  if (personalInstitution) {
    redirect(`/institution/${personalInstitution.slug}`);
  }

  return <PersonalInstitutionCreateShell expectedUserId={session.user.id} />;
}
