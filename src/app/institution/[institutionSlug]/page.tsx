import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon, PageHeader } from "@/components/ui";
import { InstitutionPublicView } from "@/components/institution/institution-public-view";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { getCurrentSession } from "@/server/auth/session";
import { resolveChargingReadiness } from "@/server/finance/charging-readiness";
import { ChargingReadinessPanel } from "@/components/institution/charging-readiness-panel";
import { INDEXABLE_ROBOTS } from "@/config/indexable-routes";
import { requireRolePage } from "@/server/auth/page-guard";
import { loadInstitutionVerificationSummaryBySlug } from "@/server/institution-workspace/institution-service";
import {
  ANONYMOUS_INSTITUTION_VIEWER,
  getPublicInstitution,
  type InstitutionPublicViewer,
} from "@/server/institution-workspace/institution-public-service";
import { listPublicCompetitions } from "@/server/competitions/competition-public-service";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";
import {
  InstitutionWorkspaceInputError,
  parseInstitutionSlugParam,
} from "@/server/institution-workspace/institution-core";

type InstitutionHubPageProps = {
  params: Promise<{ institutionSlug: string }>;
  searchParams: Promise<{ tampilan?: string }>;
};

// How many of the institution's published competitions the public page shows before pointing at
// the full listing.
const PUBLIC_COMPETITION_LIMIT = 12;

// Owners and staff land on the management board; everyone else — signed out, signed in as a
// candidate, or a member of a different institution — sees the organizer's public page at the same
// URL. `?tampilan=publik` lets an owner look at their own public page, which they otherwise never
// could.
const PUBLIC_VIEW_PARAM = "publik";

/**
 * The slug this URL names, normalised exactly as the lookup normalises it, or `null` for a value
 * that cannot be a slug at all.
 *
 * The hub/public decision, the hub's own links and every lookup on this page read this one string
 * and never the raw route parameter: the column it is compared against stores slugs lowercase, so a
 * membership check made against the parameter as typed answers no for an owner who typed the URL in
 * capitals (LAUNCH-D161). The canonical is the exception and reads the slug the ROW stores instead,
 * so the address it declares is the one the institution is actually filed under.
 */
function resolveSlugParam(rawSlug: string): string | null {
  try {
    return parseInstitutionSlugParam(rawSlug);
  } catch (error) {
    if (error instanceof InstitutionWorkspaceInputError) return null;
    throw error;
  }
}

export async function generateMetadata({ params }: InstitutionHubPageProps): Promise<Metadata> {
  const { institutionSlug } = await params;
  const slug = resolveSlugParam(institutionSlug);
  const institution = slug ? await getPublicInstitution(slug) : null;

  if (!slug || !institution) {
    return { title: "Institusi tidak ditemukan · Lombakita" };
  }

  const title = `${institution.name} · Lombakita`;
  const description =
    institution.description ?? `Kompetisi yang diselenggarakan ${institution.name} di Lombakita.`;
  const path = `/institution/${institution.slug}`;

  return {
    title,
    description,
    // Every institution page that renders is indexable, and listSitemapInstitutions lists the same
    // institutions.
    robots: INDEXABLE_ROBOTS,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: path,
      type: "profile",
      siteName: "Lombakita",
      images: institution.logoUrl ? [{ url: institution.logoUrl }] : undefined,
    },
    twitter: {
      card: institution.logoUrl ? "summary_large_image" : "summary",
      title,
      description,
    },
  };
}

export default async function InstitutionHubPage({
  params,
  searchParams,
}: InstitutionHubPageProps) {
  const { institutionSlug } = await params;
  const { tampilan } = await searchParams;

  const slug = resolveSlugParam(institutionSlug);
  if (!slug) notFound();

  const base = `/institution/${slug}`;

  // The guard deliberately runs AFTER the membership check rather than before it: this URL is now
  // a public page for anyone who is not running the institution, so requiring a recruiter session
  // up front would bounce every visitor to sign-in.
  const session = await getCurrentSession();
  const isAdmin = session?.user?.id ? await isInstitutionAdminBySlug(session.user.id, slug) : false;

  if (!isAdmin || tampilan === PUBLIC_VIEW_PARAM) {
    // `isPlatformOps` and `isPreview` are read here and resolved in the service, so the contact
    // decision is made against the database for THIS viewer rather than by a client that could be
    // wrong about who is looking.
    const viewer = session?.user?.suspendedAt
      ? ANONYMOUS_INSTITUTION_VIEWER
      : {
          userId: session?.user?.id ?? null,
          isPlatformOps:
            session?.user?.role === "platform_ops" && session.user.mfaStatus === "satisfied",
          isPreview: tampilan === PUBLIC_VIEW_PARAM,
        };
    return renderPublicView(slug, viewer);
  }

  await requireRolePage("recruiter", { callbackPath: base });

  const verificationSummary = await loadInstitutionVerificationSummaryBySlug(slug);
  const isPersonal = isPersonalInstitutionType(verificationSummary?.institutionType ?? null);
  const isVerified = verificationSummary?.verificationStatus === "verified";

  // DEC-0170: a defined runtime state, surfaced where the organiser can act on it rather than left
  // for a candidate to discover by failing to register.
  const chargingReadiness = verificationSummary
    ? await resolveChargingReadiness(verificationSummary.institutionId)
    : null;

  const links = [
    {
      href: `${base}/competitions`,
      label: "Kompetisi",
      description: "Buat, terbitkan, dan tinjau partisipasi kompetisi.",
      icon: "trophy" as const,
    },
    {
      href: `${base}/team`,
      label: "Tim",
      description: "Kelola anggota, peran, dan undangan pengelola.",
      icon: "users" as const,
    },
    {
      href: `${base}/settings`,
      label: "Pengaturan",
      description: "Perbarui identitas institusi dan profil penyelenggara.",
      icon: "building" as const,
    },
    // A personal workspace cannot submit verification documents (the verification service refuses
    // its kind), so its hub offers no verification card.
    ...(isPersonal
      ? []
      : [
          {
            href: `${base}/verification`,
            label: "Verifikasi dokumen",
            description: isVerified
              ? "Institusi ini sudah terverifikasi. Lihat hasil peninjauannya."
              : "Ajukan bukti resmi dan pantau status tinjauan.",
            icon: "check" as const,
          },
        ]),
    {
      href: `${base}/fees`,
      label: "Biaya layanan tercatat",
      description: "Lihat biaya layanan Lombakita yang tercatat atas lembaga Anda.",
      icon: "settings" as const,
    },
    {
      href: `${base}/audit-log`,
      label: "Log audit",
      description: "Telusuri perubahan penting dalam urutan waktu.",
      icon: "inbox" as const,
    },
  ];

  return (
    <main className="page-shell app-page institution-hub-page">
      <PageHeader
        title={verificationSummary?.displayName || slug}
        backHref="/recruiter-dashboard"
        backName="Dasbor penyelenggara"
        action={{
          kind: "text",
          href: `${base}?tampilan=${PUBLIC_VIEW_PARAM}`,
          label: "Lihat halaman publik",
          icon: "eye",
        }}
      />
      {chargingReadiness && !chargingReadiness.ready ? (
        <ChargingReadinessPanel blockers={chargingReadiness.blockers} institutionSlug={slug} />
      ) : null}

      <nav aria-label="Fitur institusi">
        <ul className="hub-grid institution-hub-grid">
          {links.map(({ href, label, description, icon }) => (
            <li key={href}>
              <Link href={href} className="hub-card">
                <span className="hub-card-icon">
                  <Icon name={icon} size="lg" />
                </span>
                <div className="stack-xs">
                  <h2>{label}</h2>
                  <p>{description}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}

async function renderPublicView(slug: string, viewer: InstitutionPublicViewer) {
  const institution = await getPublicInstitution(slug, viewer);
  if (!institution) notFound();

  // "all" rather than the default: an organizer's page is their public record, so finished
  // competitions belong on it — that record is what a participant returns to after the event.
  const { data: competitions } = await listPublicCompetitions({
    institutionSlug: institution.slug,
    status: "all",
    limit: PUBLIC_COMPETITION_LIMIT,
  });

  return <InstitutionPublicView institution={institution} competitions={competitions} />;
}
