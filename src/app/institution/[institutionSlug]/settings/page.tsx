import { InstitutionSettingsShell } from "@/components/institution/institution-settings-shell";
import { getCurrentSession } from "@/server/auth/session";
import { isInstitutionOwnerBySlug } from "@/server/institution-members/member-service";
import { redirect } from "next/navigation";

type InstitutionSettingsPageProps = {
  params: Promise<{
    institutionSlug: string;
  }>;
};

export default async function InstitutionSettingsPage({ params }: InstitutionSettingsPageProps) {
  const session = await getCurrentSession();
  const { institutionSlug } = await params;
  const settingsPath = `/institution/${institutionSlug}/settings`;

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(settingsPath)}`);
  }

  // CCR-05 / CCR-09: only recruiter-verified accounts can ever own or staff an institution.
  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/");
  }

  // Settings is owner-only per institution_workspace_shell_step_2_2.settings_authorization_rule.
  // Redirect non-owners (including staff and recruiters from other institutions) before render.
  const isOwner = await isInstitutionOwnerBySlug(session.user.id, institutionSlug);
  if (!isOwner) {
    redirect("/");
  }

  return <InstitutionSettingsShell institutionSlug={institutionSlug} />;
}
