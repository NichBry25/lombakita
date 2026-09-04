import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ButtonLink, Icon, PageHeader } from "@/components/ui";
import { InstitutionPublicView } from "@/components/institution/institution-public-view";
import { isInstitutionAdminBySlug } from "@/server/institution-members/member-service";
import { getCurrentSession } from "@/server/auth/session";
import { resolveChargingReadiness } from "@/server/finance/charging-readiness";
import { ChargingReadinessPanel } from "@/components/institution/charging-readiness-panel";
import { INDEXABLE_ROBOTS } from "@/config/indexable-routes";
import { requireRolePage } from "@/server/auth/page-guard";
import { loadInstitutionVerificationSummaryBySlug } from "@/server/institution-workspace/institution-service";
import { getPublicInstitution } from "@/server/institution-workspace/institution-public-service";
import { listPublicCompetitions } from "@/server/competitions/competition-public-service";
import { isPersonalInstitutionType } from "@/server/institution-workspace/institution-type";

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

export async function generateMetadata({ params }: InstitutionHubPageProps): Promise<Metadata> {
  const { institutionSlug } = await params;
  const institution = await getPublicInstitution(institutionSlug);
  if (!institution) {
    return { title: "Institusi tidak ditemukan · Lombakita" };
  }

  const title = `${institution.name} · Lombakita`;
  const description =
    institution.description ?? `Kompetisi yang diselenggarakan ${institution.name} di Lombakita.`;
  const path = `/institution/${institutionSlug}`;

  // A personal institution's public page redirects to the owner's profile, which is withheld from
  // search (DEC-0196). Inviting a crawler to this URL would advertise a redirect into a page it
  // may not index, so only a real organizer page opts in.
  const isPublicOrganizerPage = !isPersonalInstitutionType(institution.institutionType);

  return {
    title,
    description,
    robots: isPublicOrganizerPage ? INDEXABLE_ROBOTS : undefined,
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
  const base = `/institution/${institutionSlug}`;

  // The guard deliberately runs AFTER the membership check rather than before it: this URL is now
  // a public page for anyone who is not running the institution, so requiring a recruiter session
  // up front would bounce every visitor to sign-in.
  const session = await getCurrentSession();
  const isAdmin = session?.user?.id
    ? await isInstitutionAdminBySlug(session.user.id, institutionSlug)
    : false;

  if (!isAdmin || tampilan === PUBLIC_VIEW_PARAM) {
    return renderPublicView(institutionSlug);
  }

  await requireRolePage("recruiter", { callbackPath: base });

  // The /verification route serves the type upgrade for a personal institution and document
  // verification for a full one, so its entry in this hub is labelled for whichever it will render —
  // and, once a full institution is verified, for the result rather than for an action it no longer
  // has.
  const verificationSummary = await loadInstitutionVerificationSummaryBySlug(institutionSlug);
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
    // A personal institution is single-member by definition and cannot invite staff, so the team
    // card would lead to a page with nothing to manage.
    ...(isPersonal
      ? []
      : [
          {
            href: `${base}/team`,
            label: "Tim",
            description: "Kelola anggota, peran, dan undangan pengelola.",
            icon: "users" as const,
          },
        ]),
    {
      href: `${base}/settings`,
      label: "Pengaturan",
      description: "Perbarui identitas institusi dan profil penyelenggara.",
      icon: "building" as const,
    },
    isPersonal
      ? {
          href: `${base}/verification`,
          label: "Tingkatkan level institusi",
          description: "Ubah institusi personal menjadi institusi resmi. Bersifat permanen.",
          icon: "building" as const,
        }
      : {
          href: `${base}/verification`,
          label: "Verifikasi dokumen",
          description: isVerified
            ? "Institusi ini sudah terverifikasi. Lihat hasil peninjauannya."
            : "Ajukan bukti resmi dan pantau status tinjauan.",
          icon: "check" as const,
        },
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
        title={verificationSummary?.displayName || institutionSlug}
        description="Kelola profil institusi, kompetisi, dan anggota."
        backHref="/recruiter-dashboard"
        backLabel="Dasbor"
        actions={
          isPersonal ? null : (
            <ButtonLink
              href={`${base}?tampilan=${PUBLIC_VIEW_PARAM}`}
              variant="primary"
              leadingIcon={<Icon name="eye" size="sm" aria-hidden="true" />}
            >
              Lihat halaman publik
            </ButtonLink>
          )
        }
      />
      {chargingReadiness && !chargingReadiness.ready ? (
        <ChargingReadinessPanel
          blockers={chargingReadiness.blockers}
          institutionSlug={institutionSlug}
        />
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

// A personal institution has no identity of its own — its name, photo and banner are all the
// owner's — so its public page is that person's profile rather than a near-duplicate of it.
async function renderPublicView(institutionSlug: string) {
  const institution = await getPublicInstitution(institutionSlug);
  if (!institution) notFound();

  if (isPersonalInstitutionType(institution.institutionType)) {
    if (!institution.personalOwnerUsername) notFound();
    redirect(`/${institution.personalOwnerUsername}`);
  }

  // "all" rather than the default: an organizer's page is their public record, so finished
  // competitions belong on it — that record is what a participant returns to after the event.
  const { data: competitions } = await listPublicCompetitions({
    institutionSlug: institution.slug,
    status: "all",
    limit: PUBLIC_COMPETITION_LIMIT,
  });

  return <InstitutionPublicView institution={institution} competitions={competitions} />;
}
