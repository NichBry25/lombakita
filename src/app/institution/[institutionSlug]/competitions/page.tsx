import { redirect } from "next/navigation";
import { InstitutionCompetitionsShell } from "@/components/institution/institution-competitions-shell";
import { getCurrentSession } from "@/server/auth/session";

type Props = { params: Promise<{ institutionSlug: string }> };

export default async function InstitutionCompetitionsPage({ params }: Props) {
  const session = await getCurrentSession();
  const { institutionSlug } = await params;
  const path = `/institution/${institutionSlug}/competitions`;
  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(path)}`);
  }
  return <InstitutionCompetitionsShell institutionSlug={institutionSlug} />;
}
