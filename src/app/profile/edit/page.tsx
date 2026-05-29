import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getOwnerProfile } from "@/server/user-profile/profile-service";
import { ProfileEditShell } from "./profile-edit-shell";

export default async function ProfileEditPage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect("/auth/sign-in?callbackUrl=/profile/edit");
  }

  const profile = await getOwnerProfile(session.user.id);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ marginBottom: "1.5rem" }}>Edit Profil</h1>
      <ProfileEditShell profile={profile} expectedUserId={session.user.id} />
    </main>
  );
}
