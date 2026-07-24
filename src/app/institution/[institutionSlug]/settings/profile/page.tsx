import { InstitutionProfileShell } from "@/components/institution/institution-profile-shell";
import { getCurrentSession } from "@/server/auth/session";
import { isInstitutionOwnerBySlug } from "@/server/institution-members/member-service";
import { redirect } from "next/navigation";

type InstitutionProfilePageProps = {
  params: Promise<{ institutionSlug: string }>;
};

export default async function InstitutionProfilePage({ params }: InstitutionProfilePageProps) {
  const session = await getCurrentSession();
  const { institutionSlug } = await params;
  const profilePath = `/institution/${institutionSlug}/settings/profile`;

  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(profilePath)}`);
  }

  if (!session.user.verifiedRoles.includes("recruiter")) {
    redirect("/");
  }

  // The public organizer profile is owner-only, same authorization boundary as institution settings.
  const isOwner = await isInstitutionOwnerBySlug(session.user.id, institutionSlug);
  if (!isOwner) {
    redirect("/");
  }

  return (
    <InstitutionProfileShell institutionSlug={institutionSlug} expectedUserId={session.user.id} />
  );
}
