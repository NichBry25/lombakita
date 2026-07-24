import { Icon } from "@/components/ui";
import type {
  CertificationEntry,
  EducationEntry,
  ExperienceEntry,
  ProfileCollections,
  SkillEntry,
  SocialLinkEntry,
  SocialPlatform,
} from "@/server/user-profile/profile-collections-core";

// Shared, read-only rendering of the five profile detail collections. Used by both the public
// ([username]) and owner (/profile) pages so the two stay visually identical. On the owner view
// empty sections render an "add via edit" hint; on the public view empty sections are hidden.

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  linkedin: "LinkedIn",
  github: "GitHub",
  instagram: "Instagram",
  x: "X",
  website: "Website",
};

const MONTH_YEAR = new Intl.DateTimeFormat("id-ID", { month: "short", year: "numeric" });

// Formats a stored "YYYY-MM-DD" string as "Mmm YYYY" (month granularity in the UI).
function formatMonthYear(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return MONTH_YEAR.format(date);
}

function experienceRange(entry: ExperienceEntry): string | null {
  const start = formatMonthYear(entry.startDate);
  const end = entry.isCurrent ? "Sekarang" : formatMonthYear(entry.endDate);
  if (start && end) return `${start} – ${end}`;
  return start ?? end ?? null;
}

function educationRange(entry: EducationEntry): string | null {
  if (entry.startYear && entry.endYear) return `${entry.startYear} – ${entry.endYear}`;
  if (entry.endYear) return `${entry.endYear}`;
  if (entry.startYear) return `${entry.startYear}`;
  return null;
}

function certificationDates(entry: CertificationEntry): string | null {
  const issued = formatMonthYear(entry.issueDate);
  const expires = formatMonthYear(entry.expiryDate);
  if (issued && expires) return `Terbit ${issued} · Berlaku s/d ${expires}`;
  if (issued) return `Terbit ${issued}`;
  if (expires) return `Berlaku s/d ${expires}`;
  return null;
}

function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="content-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

function EmptyHint({ label }: { label: string }) {
  return <p className="pf-empty">Belum ada {label}. Tambahkan lewat Edit profil.</p>;
}

function ExperienceList({ items }: { items: ExperienceEntry[] }) {
  return (
    <ul className="pf-timeline">
      {items.map((entry) => {
        const range = experienceRange(entry);
        return (
          <li key={entry.id} className="pf-timeline-item">
            <p className="pf-entry-title">{entry.title}</p>
            <p className="pf-entry-sub">
              {entry.organizationName}
              {entry.location ? ` · ${entry.location}` : ""}
            </p>
            {range && <p className="pf-entry-meta">{range}</p>}
            {entry.description && <p className="pf-entry-body">{entry.description}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function EducationList({ items }: { items: EducationEntry[] }) {
  return (
    <ul className="pf-timeline">
      {items.map((entry) => {
        const range = educationRange(entry);
        const sub = [entry.degree, entry.fieldOfStudy].filter(Boolean).join(" · ");
        return (
          <li key={entry.id} className="pf-timeline-item">
            <p className="pf-entry-title">{entry.school}</p>
            {sub && <p className="pf-entry-sub">{sub}</p>}
            {range && <p className="pf-entry-meta">{range}</p>}
            {entry.description && <p className="pf-entry-body">{entry.description}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function SkillList({ items }: { items: SkillEntry[] }) {
  return (
    <ul className="pf-tags">
      {items.map((entry) => (
        <li key={entry.id} className="pf-tag">
          {entry.name}
        </li>
      ))}
    </ul>
  );
}

function CertificationList({ items }: { items: CertificationEntry[] }) {
  return (
    <ul className="pf-timeline">
      {items.map((entry) => {
        const dates = certificationDates(entry);
        return (
          <li key={entry.id} className="pf-timeline-item">
            <p className="pf-entry-title">{entry.name}</p>
            <p className="pf-entry-sub">{entry.issuer}</p>
            {dates && <p className="pf-entry-meta">{dates}</p>}
            {entry.credentialId && (
              <p className="pf-entry-meta">ID kredensial: {entry.credentialId}</p>
            )}
            {entry.credentialUrl && (
              <a
                className="pf-website"
                href={entry.credentialUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="link" size="sm" aria-hidden="true" />
                Lihat kredensial
              </a>
            )}
            {entry.fileUrl && (
              <a
                className="pf-website"
                href={entry.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="inbox" size="sm" aria-hidden="true" />
                Unduh berkas
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SocialLinkList({ items }: { items: SocialLinkEntry[] }) {
  return (
    <ul className="pf-links">
      {items.map((entry) => (
        <li key={entry.id}>
          <a className="pf-website" href={entry.url} target="_blank" rel="noopener noreferrer">
            <Icon name="link" size="sm" aria-hidden="true" />
            <span>
              {PLATFORM_LABELS[entry.platform]}
              <span className="pf-link-host"> · {linkHost(entry.url)}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function ProfileDetailSections({
  collections,
  variant,
}: {
  collections: ProfileCollections;
  variant: "owner" | "public";
}) {
  const isOwner = variant === "owner";
  const { experiences, educations, skills, certifications, socialLinks } = collections;

  return (
    <>
      {(experiences.length > 0 || isOwner) && (
        <Section eyebrow="Karier" title="Pengalaman">
          {experiences.length > 0 ? (
            <ExperienceList items={experiences} />
          ) : (
            <EmptyHint label="pengalaman" />
          )}
        </Section>
      )}

      {(educations.length > 0 || isOwner) && (
        <Section eyebrow="Pendidikan" title="Riwayat pendidikan">
          {educations.length > 0 ? (
            <EducationList items={educations} />
          ) : (
            <EmptyHint label="riwayat pendidikan" />
          )}
        </Section>
      )}

      {(skills.length > 0 || isOwner) && (
        <Section eyebrow="Keahlian" title="Keahlian">
          {skills.length > 0 ? <SkillList items={skills} /> : <EmptyHint label="keahlian" />}
        </Section>
      )}

      {(certifications.length > 0 || isOwner) && (
        <Section eyebrow="Sertifikasi" title="Sertifikasi & lisensi">
          {certifications.length > 0 ? (
            <CertificationList items={certifications} />
          ) : (
            <EmptyHint label="sertifikasi" />
          )}
        </Section>
      )}

      {(socialLinks.length > 0 || isOwner) && (
        <Section eyebrow="Tautan" title="Tautan sosial">
          {socialLinks.length > 0 ? (
            <SocialLinkList items={socialLinks} />
          ) : (
            <EmptyHint label="tautan sosial" />
          )}
        </Section>
      )}
    </>
  );
}
