import { InstitutionTeamShell } from "@/components/institution/institution-team-shell";
import { getCurrentSession } from "@/server/auth/session";
import { redirect } from "next/navigation";

type InstitutionTeamPageProps = {
  params: Promise<{ institutionSlug: string }>;
};

export default async function InstitutionTeamPage({ params }: InstitutionTeamPageProps) {
  const session = await getCurrentSession();
  const { institutionSlug } = await params;
  const teamPath = `/institution/${institutionSlug}/settings/team`;

  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(teamPath)}`);
  }

  return <InstitutionTeamShell institutionSlug={institutionSlug} />;
}
