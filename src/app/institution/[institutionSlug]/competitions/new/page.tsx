import { redirect } from "next/navigation";
import { InstitutionCompetitionCreateShell } from "@/components/institution/institution-competition-create-shell";
import { getCurrentSession } from "@/server/auth/session";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";

type Props = { params: Promise<{ institutionSlug: string }> };

export default async function InstitutionCompetitionCreatePage({ params }: Props) {
  const session = await getCurrentSession();
  const { institutionSlug } = await params;
  const path = `/institution/${institutionSlug}/competitions/new`;
  if (!session?.user?.id) {
    redirect(`/auth/sign-in?callbackUrl=${encodeURIComponent(path)}`);
  }
  if (session.user.role !== "recruiter") {
    redirect("/");
  }
  const isAdmin = await isInstitutionAdminBySlug(session.user.id, institutionSlug);
  if (!isAdmin) {
    redirect("/");
  }
  return <InstitutionCompetitionCreateShell institutionSlug={institutionSlug} />;
}
