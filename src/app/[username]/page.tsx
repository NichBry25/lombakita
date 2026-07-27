import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Icon } from "@/components/ui";
import { ProfileDetailSections } from "@/components/profile/profile-detail-sections";
import { getCurrentSession } from "@/server/auth/session";
import { deriveProfileHeader } from "@/server/user-profile/profile-collections-core";
import { getPublicProfile, isUsernameOwnedBy } from "@/server/user-profile/profile-service";

// Renders a validated http(s) URL as its bare host for compact display.
function displayUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>;
}): Promise<Metadata> {
  const { username } = await params;
  const profile = await getPublicProfile(username);
  if (!profile) {
    return { title: "Profil tidak ditemukan · Lombakita" };
  }
  const name = profile.displayName ?? `@${profile.username}`;
  return {
    title: `${name} · Lombakita`,
    description: profile.bio ?? `Profil ${name} di Lombakita.`,
  };
}

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

  const displayName = profile.displayName ?? `@${profile.username}`;
  const { affiliation, websiteUrl } = deriveProfileHeader(profile.collections);

  return (
    <main className="page-shell app-page pf-page">
      <article className="pf-card">
        <div className="pf-banner" aria-hidden="true" />
        <div className="pf-identity">
          <div className="pf-identity-head">
            <span className="pf-avatar">
              {profile.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={profile.avatarUrl} alt="" />
              ) : (
                <Icon name="user" size="xl" aria-hidden="true" />
              )}
            </span>
          </div>

          <div className="pf-name-block">
            <h1 className="pf-name">{displayName}</h1>
            <p className="pf-handle">@{profile.username}</p>

            {profile.bio && <p className="pf-headline">{profile.bio}</p>}

            {(affiliation || profile.location) && (
              <div className="pf-meta">
                {affiliation && (
                  <span className="pf-meta-item">
                    <Icon name="building" size="sm" className="pf-meta-icon" />
                    {affiliation}
                  </span>
                )}
                {profile.location && (
                  <span className="pf-meta-item">
                    <Icon name="pin" size="sm" className="pf-meta-icon" />
                    {profile.location}
                  </span>
                )}
              </div>
            )}

            {websiteUrl && (
              <a className="pf-website" href={websiteUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="link" size="sm" aria-hidden="true" />
                {displayUrl(websiteUrl)}
              </a>
            )}

            {(profile.candidateVerified || profile.recruiterVerified) && (
              <div className="pf-badges">
                {profile.candidateVerified && (
                  <span className="status-badge" data-status="open">
                    <Icon name="check" size="sm" aria-hidden="true" />
                    Kandidat Terverifikasi
                  </span>
                )}
                {profile.recruiterVerified && !profile.trustedRecruiter && (
                  <span className="status-badge" data-status="open">
                    <Icon name="check" size="sm" aria-hidden="true" />
                    Rekruter Terverifikasi
                  </span>
                )}
                {profile.trustedRecruiter && (
                  <span className="status-badge" data-status="open">
                    <Icon name="check" size="sm" aria-hidden="true" />
                    Rekruter Terpercaya
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </article>

      {profile.resume && (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Dokumen</p>
              <h2>Resume</h2>
            </div>
          </div>
          {profile.resume.downloadUrl ? (
            <a
              className="pf-website"
              href={profile.resume.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="inbox" size="sm" aria-hidden="true" />
              Unduh resume
            </a>
          ) : (
            <p className="pf-entry-sub">{profile.resume.fileName}</p>
          )}
        </section>
      )}

      <ProfileDetailSections collections={profile.collections} variant="public" />
    </main>
  );
}
