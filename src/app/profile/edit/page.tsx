import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getOwnerProfile } from "@/server/user-profile/profile-service";
import { PageHeader } from "@/components/ui";
import { ProfileEditShell } from "./profile-edit-shell";

export default async function ProfileEditPage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/profile/edit");
  }

  const profile = await getOwnerProfile(session.user.id);

  return (
    <main className="page-shell app-page profile-edit-page">
      <PageHeader
        eyebrow="Pengaturan profil"
        title="Edit profil"
        description="Perbarui identitas publik dan detail peran Anda. Bidang yang terkunci membutuhkan verifikasi peran terkait."
      />
      <ProfileEditShell profile={profile} expectedUserId={session.user.id} />
    </main>
  );
}
