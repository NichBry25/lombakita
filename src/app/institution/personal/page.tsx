import { PersonalInstitutionCreateShell } from "@/components/institution/personal-institution-create-shell";
import { getCurrentSession } from "@/server/auth/session";
import { findOwnedPersonalInstitution } from "@/server/institution-workspace/institution-service";
import { redirect } from "next/navigation";

const PERSONAL_INSTITUTION_PATH = "/institution/personal";

// Step 6.5f.1 — minimal-proof create surface for a personal institution. Recruiter session
// required. The expected user id is rendered from the server-side session and threaded into the
// client shell for the Rule #16 cross-session guard.
export default async function PersonalInstitutionPage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(PERSONAL_INSTITUTION_PATH)}`);
  }

  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/");
  }

  const personalInstitution = await findOwnedPersonalInstitution(session.user.id);
  if (personalInstitution) {
    redirect(`/institution/${personalInstitution.slug}`);
  }

  return <PersonalInstitutionCreateShell expectedUserId={session.user.id} />;
}
