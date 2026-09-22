import Link from "next/link";
import { Feedback, Icon } from "@/components/ui";
import {
  CompetitionCard,
  type CompetitionCardItem,
} from "@/components/competitions/competition-card";
import { IdentityBanner } from "@/components/media/identity-banner";
import { formatDisplayToken } from "@/lib/text/capitalize";
import type { PublicInstitution } from "@/server/institution-workspace/institution-public-service";

const INSTITUTION_TYPE_LABELS: Record<string, string> = {
  personal: "Personal",
  company: "Perusahaan",
  foundation: "Yayasan",
  university: "Universitas",
  campus_organization: "Organisasi kampus",
};

// Renders a validated http(s) URL as its bare host for compact display.
function displayUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const SOCIAL_LABELS: Record<string, string> = {
  website: "Website",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  x: "X",
  github: "GitHub",
};

// The organizer's public face: who they are, what they are running, and how to reach them. Shares
// the profile card's banner/avatar geometry so a person and an organization read as the same kind
// of page.
export function InstitutionPublicView({
  institution,
  competitions,
}: {
  institution: PublicInstitution;
  competitions: CompetitionCardItem[];
}) {
  const typeLabel = INSTITUTION_TYPE_LABELS[institution.institutionType] ?? null;
  const { contactDisclosure } = institution;

  // The notice states exist to SAY something, so they keep the section alive even when the contact
  // fields themselves were nulled on the server — otherwise the members-only notice would be
  // dropped for an institution whose only public detail is a social link, and the preview notice
  // would never render at all.
  const showContactSection =
    contactDisclosure.kind === "members_only" ||
    contactDisclosure.kind === "preview_hidden" ||
    Boolean(
      institution.contactName ||
      institution.contactEmail ||
      institution.contactPhone ||
      institution.socialLinks.length > 0,
    );

  return (
    <main className="page-shell app-page pf-page">
      <article className="pf-card">
        <IdentityBanner bannerUrl={institution.bannerUrl} />

        <div className="pf-identity">
          <div className="pf-identity-head">
            <span className="pf-avatar">
              {institution.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={institution.logoUrl} alt="" />
              ) : (
                <Icon name="building" size="xl" aria-hidden="true" />
              )}
            </span>
          </div>

          <div className="pf-name-block">
            <h1 className="pf-name">{institution.name}</h1>
            <p className="pf-handle">@{institution.slug}</p>

            {institution.description && <p className="pf-headline">{institution.description}</p>}

            <div className="pf-meta">
              {typeLabel && (
                <span className="pf-meta-item">
                  <Icon name="building" size="sm" className="pf-meta-icon" />
                  {typeLabel}
                </span>
              )}
            </div>

            {institution.websiteUrl && (
              <a
                className="pf-website"
                href={institution.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="link" size="sm" aria-hidden="true" />
                {displayUrl(institution.websiteUrl)}
              </a>
            )}

            {institution.isVerified && (
              <div className="pf-badges">
                <span className="status-badge" data-status="open">
                  <Icon name="check" size="sm" aria-hidden="true" />
                  Institusi Terverifikasi
                </span>
              </div>
            )}
          </div>
        </div>
      </article>

      {institution.about && (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Tentang</p>
              <h2>Profil {institution.name}</h2>
            </div>
          </div>
          <p className="detail-description">{institution.about}</p>
        </section>
      )}

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Kompetisi</p>
            <h2>Sedang dibuka</h2>
          </div>
        </div>
        {competitions.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state-icon" aria-hidden="true">
              <Icon name="trophy" size="xl" />
            </span>
            <h3>Belum ada kompetisi yang terbit.</h3>
            <p>Kompetisi dari penyelenggara ini akan tampil di sini setelah dipublikasikan.</p>
          </div>
        ) : (
          <div className="competition-grid competition-grid--roomy">
            {competitions.map((competition) => (
              <CompetitionCard
                key={competition.id}
                competition={competition}
                showOrganizer={false}
              />
            ))}
          </div>
        )}
      </section>

      {showContactSection && (
        <section className="content-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Kontak</p>
              <h2>Hubungi penyelenggara</h2>
            </div>
          </div>
          {contactDisclosure.kind === "members_only" && (
            <Feedback tone="info">
              {/* Two different reasons one section is visible: a relationship with the institution,
                  or a platform-ops account looking in without one. The second is not a member, so
                  the members-only sentence would be false to them. */}
              <p>
                {contactDisclosure.viewerIsPlatformOps
                  ? "Kontak ini terlihat oleh Anda sebagai tim Lombakita. Publik akan melihatnya setelah institusi terverifikasi."
                  : "Kontak ini hanya terlihat oleh anggota institusi. Publik akan melihatnya setelah institusi terverifikasi."}
              </p>
              {contactDisclosure.canRequestVerification && (
                <Link href={`/institution/${institution.slug}/verification`}>
                  Ajukan verifikasi
                </Link>
              )}
            </Feedback>
          )}
          {contactDisclosure.kind === "preview_hidden" && (
            <Feedback tone="info">
              Kontak disembunyikan dari publik sampai institusi terverifikasi.
            </Feedback>
          )}
          <div className="stack-xs">
            {institution.contactName && (
              <p className="pf-entry-sub">
                <Icon name="user" size="sm" className="pf-meta-icon" />
                {institution.contactName}
              </p>
            )}
            {institution.contactEmail && (
              <a className="pf-website" href={`mailto:${institution.contactEmail}`}>
                <Icon name="inbox" size="sm" aria-hidden="true" />
                {institution.contactEmail}
              </a>
            )}
            {institution.contactPhone && <p className="pf-entry-sub">{institution.contactPhone}</p>}
            {institution.socialLinks.map((link) => (
              <a
                key={link.platform}
                className="pf-website"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="link" size="sm" aria-hidden="true" />
                {SOCIAL_LABELS[link.platform] ?? formatDisplayToken(link.platform)}
              </a>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
