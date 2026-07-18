import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, ButtonLink, Icon } from "@/components/ui";
import { sessionHasRole } from "@/lib/access/roles";
import { getCurrentSession } from "@/server/auth/session";
import {
  getPublicCompetitionDetail,
  type PublicCompetitionDetail,
} from "@/server/competitions/competition-public-service";
import { isSavedCompetition } from "@/server/saved-competitions/saved-competition-service";
import { SaveButton } from "./save-button";
import { formatTeamSizeText } from "./team-size-utils";

const CATEGORY_LABELS: Record<string, string> = {
  technology: "Teknologi",
  science: "Sains",
  business: "Bisnis",
  creative_arts: "Seni & Kreasi",
  social_humanities: "Sosial & Humaniora",
  sports: "Olahraga",
  academic: "Akademik",
  other: "Lainnya",
};

const MODE_LABELS: Record<string, string> = {
  individual: "Individu",
  team: "Tim",
  both: "Individu / Tim",
};

const formatDate = (date: Date | string | null) =>
  date
    ? new Date(date).toLocaleDateString("id-ID", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";

const formatDateTime = (date: Date | string | null) =>
  date
    ? new Date(date).toLocaleString("id-ID", {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function FeeDisplay({ feeAmount }: { feeAmount: string | null }) {
  const amount = feeAmount ? parseFloat(feeAmount) : 0;
  if (!feeAmount || amount === 0) {
    return <p className="detail-fee-free">Gratis</p>;
  }

  return (
    <div className="stack-xs">
      <p className="detail-fee-amount">Rp {amount.toLocaleString("id-ID")}</p>
      <p className="detail-rail-note">Pembayaran online segera hadir.</p>
    </div>
  );
}

function CTANavLink({
  ctaState,
  registrationPath,
  isCandidate,
}: {
  ctaState: PublicCompetitionDetail["ctaState"];
  registrationPath: string;
  isCandidate: boolean;
}) {
  if (ctaState === "open" && isCandidate) {
    return (
      <ButtonLink href={registrationPath} variant="primary" size="lg" fullWidth>
        Daftar kompetisi
        <Icon name="arrow-right" size="md" />
      </ButtonLink>
    );
  }

  if (ctaState === "open" && !isCandidate) {
    return (
      <Button disabled size="lg" fullWidth>
        Daftar kompetisi
      </Button>
    );
  }

  return (
    <Button disabled size="lg" fullWidth>
      {ctaState === "not_yet_open" ? "Pendaftaran belum dibuka" : "Pendaftaran ditutup"}
    </Button>
  );
}

function RegistrationStatus({ ctaState }: { ctaState: PublicCompetitionDetail["ctaState"] }) {
  const label =
    ctaState === "open"
      ? "Pendaftaran dibuka"
      : ctaState === "not_yet_open"
        ? "Belum dibuka"
        : "Pendaftaran ditutup";
  const status = ctaState === "open" ? "open" : ctaState === "closed" ? "closed" : undefined;

  return (
    <span className="status-badge" data-status={status}>
      {label}
    </span>
  );
}

export default async function CompetitionDetailPage({
  params,
}: {
  params: Promise<{ institutionSlug: string; slug: string }>;
}) {
  const { institutionSlug, slug } = await params;
  const [competition, session] = await Promise.all([
    getPublicCompetitionDetail(institutionSlug, slug),
    getCurrentSession(),
  ]);

  if (!competition) notFound();

  const isCandidate = sessionHasRole(
    session?.user?.role,
    session?.user?.verifiedRoles,
    "candidate",
  );
  const initialSaved = isCandidate
    ? await isSavedCompetition(session!.user.id, competition.id)
    : false;

  const registrationPath = `/competitions/${institutionSlug}/${slug}/registration`;
  const showTeamSize =
    competition.mode !== "individual" &&
    (competition.minTeamSize !== null || competition.maxTeamSize !== null);

  return (
    <main>
      <section
        className="brand-band competition-detail-hero"
        data-category={competition.category ?? "other"}
      >
        <div className="content-shell competition-detail-hero-inner">
          <Link href="/competitions" className="detail-back-link">
            <span aria-hidden="true">←</span>
            Semua kompetisi
          </Link>

          <div className="detail-hero-content stack-md">
            <div className="cluster">
              <RegistrationStatus ctaState={competition.ctaState} />
              {competition.category ? (
                <span className="status-badge">
                  {CATEGORY_LABELS[competition.category] ?? competition.category}
                </span>
              ) : null}
              {competition.mode ? (
                <span className="status-badge">
                  {MODE_LABELS[competition.mode] ?? competition.mode}
                </span>
              ) : null}
            </div>

            <h1>{competition.title}</h1>

            <div className="detail-organizer-line">
              {competition.organizer.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={competition.organizer.logoUrl} alt="" />
              ) : (
                <span className="detail-organizer-mark" aria-hidden="true">
                  <Icon name="trophy" size="sm" />
                </span>
              )}
              <span>Diselenggarakan oleh {competition.organizer.name}</span>
            </div>
          </div>
        </div>
      </section>

      <div className="page-shell detail-layout">
        <article className="detail-main stack-lg">
          {competition.description ? (
            <section className="surface-card card-padding-lg stack-md">
              <div className="stack-xs">
                <p className="eyebrow">Tentang kompetisi</p>
                <h2 className="section-title">Gambaran umum</h2>
              </div>
              <p className="detail-description">{competition.description}</p>
            </section>
          ) : null}

          <section className="surface-card card-padding-lg stack-md">
            <div className="stack-xs">
              <p className="eyebrow">Jadwal</p>
              <h2 className="section-title">Tanggal penting</h2>
            </div>
            <div className="detail-timeline">
              <div className="detail-timeline-item">
                <span className="detail-timeline-node" aria-hidden="true" />
                <div>
                  <span>Pendaftaran dibuka</span>
                  <strong>{formatDateTime(competition.registrationStartAt)}</strong>
                </div>
              </div>
              <div className="detail-timeline-item" data-key-date="true">
                <span className="detail-timeline-node" aria-hidden="true" />
                <div>
                  <span>Batas pendaftaran</span>
                  <strong>{formatDateTime(competition.registrationEndAt)}</strong>
                </div>
              </div>
              <div className="detail-timeline-item">
                <span className="detail-timeline-node" aria-hidden="true" />
                <div>
                  <span>Mulai kompetisi</span>
                  <strong>{formatDate(competition.eventStartAt)}</strong>
                </div>
              </div>
              <div className="detail-timeline-item">
                <span className="detail-timeline-node" aria-hidden="true" />
                <div>
                  <span>Akhir kompetisi</span>
                  <strong>{formatDate(competition.eventEndAt)}</strong>
                </div>
              </div>
            </div>
          </section>

          <div className="detail-information-grid">
            {showTeamSize ? (
              <section className="surface-card card-padding stack-md">
                <span className="detail-info-icon" aria-hidden="true">
                  <Icon name="users" size="lg" />
                </span>
                <div className="stack-xs">
                  <p className="eyebrow">Format peserta</p>
                  <h2>Ukuran tim</h2>
                  <p>{formatTeamSizeText(competition.minTeamSize, competition.maxTeamSize)}</p>
                </div>
              </section>
            ) : null}

            <section className="surface-card card-padding stack-md">
              <span className="detail-info-icon" aria-hidden="true">
                <Icon name="check" size="lg" />
              </span>
              <div className="stack-xs">
                <p className="eyebrow">Persyaratan</p>
                <h2>Kelayakan dasar</h2>
                <p>Mahasiswa aktif usia 18–32 tahun.</p>
              </div>
            </section>
          </div>

          <section className="inset-panel card-padding-lg detail-organizer-card">
            <span className="detail-organizer-mark detail-organizer-mark-large" aria-hidden="true">
              <Icon name="trophy" size="lg" />
            </span>
            <div className="stack-xs">
              <p className="eyebrow">Penyelenggara</p>
              <h2>{competition.organizer.name}</h2>
              <p className="muted-copy">
                Informasi kompetisi dan tahapan partisipasi dikelola oleh penyelenggara ini.
              </p>
            </div>
          </section>
        </article>

        <aside className="glass-focus detail-cta-rail" aria-label="Ringkasan pendaftaran">
          <div className="stack-sm">
            <RegistrationStatus ctaState={competition.ctaState} />
            <div className="stack-xs">
              <p className="eyebrow">Batas pendaftaran</p>
              <p className="detail-deadline data-text">
                {formatDateTime(competition.registrationEndAt)}
              </p>
            </div>
          </div>

          <div className="detail-rail-divider" />

          <div className="stack-xs">
            <p className="eyebrow">Biaya pendaftaran</p>
            <FeeDisplay feeAmount={competition.feeAmount} />
          </div>

          <div className="detail-rail-actions">
            <CTANavLink
              ctaState={competition.ctaState}
              registrationPath={registrationPath}
              isCandidate={isCandidate}
            />
            {!session?.user ? (
              <p className="detail-rail-note">
                <Link href="/auth/login">Masuk</Link> sebagai mahasiswa untuk mendaftar.
              </p>
            ) : null}
            {session?.user && !isCandidate ? (
              <p className="detail-rail-note">Hanya akun kandidat yang dapat mendaftar.</p>
            ) : null}

            {isCandidate ? (
              <SaveButton
                competitionId={competition.id}
                initialSaved={initialSaved}
                expectedUserId={session!.user.id}
              />
            ) : (
              <p className="detail-rail-note">
                <Link href="/auth/login">Masuk</Link> untuk menyimpan kompetisi ini.
              </p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
