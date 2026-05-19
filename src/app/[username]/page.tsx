import { notFound, redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getPublicProfile, isUsernameOwnedBy } from "@/server/user-profile/profile-service";

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;

  // CCR-14 / DEC-0048: If the current user is the owner of this username, redirect server-side
  // to /profile. This must be a server-side redirect — no client-side flash of public view.
  const session = await getCurrentSession();
  if (session?.user?.id) {
    const isOwner = await isUsernameOwnedBy(username, session.user.id);
    if (isOwner) {
      redirect("/profile");
    }
  }

  const profile = await getPublicProfile(username);
  if (!profile) notFound();

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ marginBottom: "0.5rem" }}>{profile.displayName ?? profile.username}</h1>
      <p style={{ color: "#555", marginBottom: "1.5rem" }}>@{profile.username}</p>

      {profile.bio && <p style={{ marginBottom: "1rem" }}>{profile.bio}</p>}
      {profile.location && (
        <p style={{ fontSize: "0.9rem", color: "#666" }}>Lokasi: {profile.location}</p>
      )}
      {profile.avatarUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={profile.avatarUrl}
          alt={profile.displayName ?? profile.username}
          style={{ width: 80, height: 80, borderRadius: "50%", marginBottom: "1rem" }}
        />
      )}

      {"university" in profile && (
        <section style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Profil Kandidat</h2>
          {profile.university && <p>Universitas: {profile.university}</p>}
          {profile.major && <p>Jurusan: {profile.major}</p>}
          {profile.graduationYear && <p>Tahun Lulus: {profile.graduationYear}</p>}
        </section>
      )}

      {"roleTitle" in profile && (
        <section style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Profil Rekruter</h2>
          {profile.roleTitle && <p>Jabatan: {profile.roleTitle}</p>}
          {profile.organizationName && <p>Organisasi: {profile.organizationName}</p>}
          {profile.websiteUrl && (
            <p>
              Website:{" "}
              <a href={profile.websiteUrl} target="_blank" rel="noopener noreferrer">
                {profile.websiteUrl}
              </a>
            </p>
          )}
        </section>
      )}
    </main>
  );
}
