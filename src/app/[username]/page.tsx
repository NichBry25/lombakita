import { notFound, redirect } from "next/navigation";
import { Icon, PageHeader } from "@/components/ui";
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
    <main className="page-shell app-page public-profile-page">
      <PageHeader
        eyebrow="Profil publik"
        title={profile.displayName ?? profile.username}
        description={`@${profile.username}`}
      />

      <section className="public-profile-hero brand-band">
        <div className="public-profile-avatar" aria-hidden={!profile.avatarUrl}>
          {profile.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={profile.avatarUrl} alt={profile.displayName ?? profile.username} />
          ) : (
            <Icon name="user" size="xl" />
          )}
        </div>
        <div className="stack-sm">
          <p className="data-text">@{profile.username}</p>
          {profile.bio && <p className="public-profile-bio">{profile.bio}</p>}
          {profile.location && (
            <p className="public-profile-location">
              <Icon name="pin" size="sm" />
              {profile.location}
            </p>
          )}
        </div>
      </section>

      {"university" in profile && (
        <section className="content-section public-profile-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Kandidat</p>
              <h2>Riwayat pendidikan</h2>
            </div>
          </div>
          <dl className="profile-detail-list">
            {profile.university && (
              <div>
                <dt>Universitas</dt>
                <dd>{profile.university}</dd>
              </div>
            )}
            {profile.major && (
              <div>
                <dt>Jurusan</dt>
                <dd>{profile.major}</dd>
              </div>
            )}
            {profile.graduationYear && (
              <div>
                <dt>Tahun lulus</dt>
                <dd className="data-text">{profile.graduationYear}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {"roleTitle" in profile && (
        <section className="content-section public-profile-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Rekruter</p>
              <h2>Identitas profesional</h2>
            </div>
          </div>
          <dl className="profile-detail-list">
            {profile.roleTitle && (
              <div>
                <dt>Jabatan</dt>
                <dd>{profile.roleTitle}</dd>
              </div>
            )}
            {profile.organizationName && (
              <div>
                <dt>Organisasi</dt>
                <dd>{profile.organizationName}</dd>
              </div>
            )}
            {profile.websiteUrl && (
              <div>
                <dt>Website</dt>
                <dd>
                  <a href={profile.websiteUrl} target="_blank" rel="noopener noreferrer">
                    {profile.websiteUrl}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </main>
  );
}
