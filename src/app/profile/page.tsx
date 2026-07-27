import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { getOwnerProfile } from "@/server/user-profile/profile-service";
import type { ProfileFieldValue } from "@/server/user-profile/profile-core";
import { deriveProfileHeader } from "@/server/user-profile/profile-collections-core";
import { ProfileDetailSections } from "@/components/profile/profile-detail-sections";
import { VerifyOtherRoleButton } from "./verify-other-role-button";
import { Icon, IconButtonLink } from "@/components/ui";

// Extracts a set value, or null when the field is empty.
function populatedValue<T>(field: ProfileFieldValue<T>): T | null {
  return field.status === "populated" ? field.value : null;
}

// Renders a validated http(s) URL as its bare host for compact display.
function displayUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default async function OwnerProfilePage() {
  const session = await getCurrentSession();

  if (!session?.user?.id) {
    redirect("/auth/login?callbackUrl=/profile");
  }

  const profile = await getOwnerProfile(session.user.id);

  const displayName = populatedValue(profile.displayName) ?? `@${profile.username}`;
  const bio = populatedValue(profile.bio);
  const location = populatedValue(profile.location);
  const avatarUrl = populatedValue(profile.avatarUrl);
  const { affiliation, websiteUrl } = deriveProfileHeader(profile.collections);

  return (
    <main className="page-shell app-page pf-page">
      <article className="pf-card">
        <div className="pf-banner" aria-hidden="true" />
        <div className="pf-identity">
          <div className="pf-identity-head">
            <span className="pf-avatar">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="" />
              ) : (
                <Icon name="user" size="xl" aria-hidden="true" />
              )}
            </span>
            <div className="pf-actions">
              {profile.candidateVerified !== profile.recruiterVerified && (
                <VerifyOtherRoleButton
                  unverifiedRoleLabel={profile.candidateVerified ? "Rekruter" : "Kandidat"}
                />
              )}
              <IconButtonLink
                href="/profile/edit"
                icon="edit"
                label="Edit profil"
                variant="primary"
                size="sm"
              />
            </div>
          </div>

          <div className="pf-name-block">
            <h1 className="pf-name">{displayName}</h1>
            <p className="pf-handle">@{profile.username}</p>

            {bio && <p className="pf-headline">{bio}</p>}

            {(affiliation || location) && (
              <div className="pf-meta">
                {affiliation && (
                  <span className="pf-meta-item">
                    <Icon name="building" size="sm" className="pf-meta-icon" />
                    {affiliation}
                  </span>
                )}
                {location && (
                  <span className="pf-meta-item">
                    <Icon name="pin" size="sm" className="pf-meta-icon" />
                    {location}
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

            <p className="pf-email">Email: {profile.email}</p>
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
          <p className="pf-entry-sub">
            {profile.resume.fileName}
            {" · "}
            {profile.resume.isPublic ? "Publik" : "Hanya Anda"}
          </p>
          {profile.resume.downloadUrl && (
            <a
              className="pf-website"
              href={profile.resume.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="inbox" size="sm" aria-hidden="true" />
              Unduh resume
            </a>
          )}
        </section>
      )}

      <ProfileDetailSections collections={profile.collections} variant="owner" />
    </main>
  );
}
