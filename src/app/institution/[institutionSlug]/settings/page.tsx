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

  return <InstitutionSettingsShell institutionSlug={institutionSlug} />;
}
