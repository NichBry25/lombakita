import { InstitutionSettingsShell } from "@/components/institution/institution-settings-shell";
import { getCurrentSession } from "@/server/auth/session";
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
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(settingsPath)}`);
  }

  // CCR-05 / CCR-09: only recruiter-verified accounts can ever own or staff an institution.
  // A candidate-only session has no path to institution settings, so we redirect away rather
  // than render an empty "no access" frame.
  if (session.user.role !== "recruiter") {
    redirect("/");
  }

  return <InstitutionSettingsShell institutionSlug={institutionSlug} />;
}
