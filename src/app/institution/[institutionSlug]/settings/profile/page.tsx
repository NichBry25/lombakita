import { InstitutionProfileShell } from "@/components/institution/institution-profile-shell";
import { requireRolePage } from "@/server/auth/page-guard";
import { isInstitutionOwnerBySlug } from "@/server/institution-members/member-service";
import { redirect } from "next/navigation";

type InstitutionProfilePageProps = {
  params: Promise<{ institutionSlug: string }>;
};

export default async function InstitutionProfilePage({ params }: InstitutionProfilePageProps) {
  const { institutionSlug } = await params;
  const profilePath = `/institution/${institutionSlug}/settings/profile`;
  const session = await requireRolePage("recruiter", { callbackPath: profilePath });

  // The public organizer profile is owner-only, same authorization boundary as institution settings.
  const isOwner = await isInstitutionOwnerBySlug(session.user.id, institutionSlug);
  if (!isOwner) {
    redirect("/");
  }

  return (
    <InstitutionProfileShell institutionSlug={institutionSlug} expectedUserId={session.user.id} />
  );
}
