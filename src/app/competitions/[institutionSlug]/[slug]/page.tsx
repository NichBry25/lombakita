import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, ButtonLink, Icon } from "@/components/ui";
import { sessionHasRole } from "@/lib/access/roles";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";
import { formatDisplayToken } from "@/lib/text/capitalize";
import { getCurrentSession } from "@/server/auth/session";
import {
  getPublicCompetitionDetail,
  listPublicCompetitions,
  type PublicCompetitionDetail,
  type PublicCompetitionItem,
} from "@/server/competitions/competition-public-service";
import { isSavedCompetition } from "@/server/saved-competitions/saved-competition-service";
import {
  getMyReview,
  getReviewSummary,
  hasConfirmedRegistration,
  listPublicReviews,
} from "@/server/competitions/competition-reviews-service";
import { SaveButton } from "./save-button";
import { DetailActions } from "./detail-actions";
import { CompetitionReviewForm } from "./competition-review-form";
import { formatTeamSizeText } from "./team-size-utils";

const SOCIAL_LABELS: Record<string, string> = {
  website: "Website",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  x: "X",
  github: "GitHub",
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

function RegistrationStatus({
  ctaState,
  registrationEndAt,
}: {
  ctaState: PublicCompetitionDetail["ctaState"];
  registrationEndAt: Date | string | null;
}) {
  const label =
    ctaState === "open"
      ? "Pendaftaran dibuka"
      : ctaState === "not_yet_open"
        ? "Belum dibuka"
        : "Pendaftaran ditutup";
  const status = ctaState === "open" ? "open" : "closed";

  return (
    <span className="status-badge" data-status={status}>
      {label} · {formatDate(registrationEndAt)}
    </span>
  );
}

function CompetitionRail({ heading, items }: { heading: string; items: PublicCompetitionItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="content-shell detail-rail-section stack-md">
      <h2 className="section-title">{heading}</h2>
      <div className="competition-grid">
        {items.map((item) => {
          const detailPath = `/competitions/${item.institutionSlug}/${item.slug}`;
          return (
            <article className="competition-card" key={item.id}>
              <Link
                href={detailPath}
                className="competition-cover"
                data-category={item.category ?? "other"}
                aria-label={`Buka ${item.title}`}
              >
                <span className="competition-cover-icon" aria-hidden="true">
                  <Icon name="trophy" size="lg" />
                </span>
                <span className="competition-cover-label">
                  {item.category ? getCompetitionCategoryLabel(item.category) : "Kompetisi"}
                </span>
              </Link>
              <div className="competition-card-body">
                <div className="competition-card-badges">
                  {item.mode ? (
                    <span className="status-badge">{getCompetitionModeLabel(item.mode)}</span>
                  ) : null}
                </div>
                <div className="stack-xs">
                  <Link href={detailPath} className="competition-title-link">
                    {item.title}
                  </Link>
                  <p className="competition-organizer">{item.institutionName}</p>
                </div>
                <div className="competition-card-footer">
                  <span className="status-badge">Batas · {formatDate(item.registrationEndAt)}</span>
                  <span className="competition-card-arrow" aria-hidden="true">
                    <Icon name="arrow-right" size="md" />
                  </span>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
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

  const [organizerRailResult, relatedRailResult, reviewSummary, reviews] = await Promise.all([
    listPublicCompetitions({ institutionSlug, limit: 4 }),
    listPublicCompetitions(
      competition.category ? { category: competition.category, limit: 8 } : { limit: 8 },
    ),
    getReviewSummary(competition.id),
    listPublicReviews(competition.id),
  ]);

  const canReview =
    isCandidate && (await hasConfirmedRegistration(session!.user.id, competition.id));
  const myReview = canReview ? await getMyReview(session!.user.id, competition.id) : null;
  const hasOrganizerContact =
    Boolean(competition.organizer.contactName) ||
    Boolean(competition.organizer.contactEmail) ||
    Boolean(competition.organizer.contactPhone) ||
    Boolean(competition.organizer.websiteUrl) ||
    competition.organizer.socialLinks.length > 0;

  const organizerRail = organizerRailResult.data.filter((c) => c.slug !== slug).slice(0, 3);
  const organizerRailIds = new Set(organizerRail.map((c) => c.id));
  const relatedRail = relatedRailResult.data
    .filter((c) => !(c.institutionSlug === institutionSlug && c.slug === slug))
    .filter((c) => !organizerRailIds.has(c.id))
    .slice(0, 3);

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
              <RegistrationStatus
                ctaState={competition.ctaState}
                registrationEndAt={competition.registrationEndAt}
              />
              {competition.category ? (
                <span className="status-badge">
                  {getCompetitionCategoryLabel(competition.category)}
                </span>
              ) : null}
              {competition.mode ? (
                <span className="status-badge">{getCompetitionModeLabel(competition.mode)}</span>
              ) : null}
              {competition.tags.map((tag) => (
                <span className="status-badge" key={tag}>
                  {tag}
                </span>
              ))}
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

          {competition.rounds.length > 0 ? (
            <section className="surface-card card-padding-lg stack-md">
              <div className="stack-xs">
                <p className="eyebrow">Tahapan</p>
                <h2 className="section-title">Tahapan &amp; linimasa</h2>
              </div>
              <div className="detail-timeline">
                {competition.rounds.map((round, index) => (
                  <div className="detail-timeline-item" key={`${round.title}-${index}`}>
                    <span className="detail-timeline-node" aria-hidden="true" />
                    <div className="stack-xs">
                      <div className="cluster">
                        <strong>{round.title}</strong>
                        {round.platformLabel ? (
                          <span className="status-badge">{round.platformLabel}</span>
                        ) : null}
                      </div>
                      {round.startsAt || round.endsAt ? (
                        <span className="data-text">
                          {formatDateTime(round.startsAt)}
                          {round.endsAt ? ` – ${formatDateTime(round.endsAt)}` : ""}
                        </span>
                      ) : null}
                      {round.description ? <p className="muted-copy">{round.description}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {competition.rounds.length === 0 ? (
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
          ) : null}

          {competition.prizes.length > 0 ? (
            <section className="surface-card card-padding-lg stack-md">
              <div className="stack-xs">
                <p className="eyebrow">Apresiasi</p>
                <h2 className="section-title">Hadiah</h2>
                {competition.prizePoolTotal ? (
                  <p className="detail-prize-total data-text">
                    Total hadiah senilai Rp {competition.prizePoolTotal.toLocaleString("id-ID")}
                  </p>
                ) : null}
              </div>
              <ul className="detail-prize-list stack-sm">
                {competition.prizes.map((prize, index) => (
                  <li key={`${prize.title}-${index}`} className="detail-prize-item stack-xs">
                    {prize.rankLabel ? <p className="eyebrow">{prize.rankLabel}</p> : null}
                    <div className="cluster">
                      <strong>{prize.title}</strong>
                      {prize.cashAmount && parseFloat(prize.cashAmount) > 0 ? (
                        <span className="status-badge">
                          Rp {parseFloat(prize.cashAmount).toLocaleString("id-ID")}
                        </span>
                      ) : null}
                      {prize.isCertificate ? (
                        <span className="status-badge">Sertifikat</span>
                      ) : null}
                    </div>
                    {prize.description ? <p className="muted-copy">{prize.description}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {showTeamSize ? (
            <div className="detail-information-grid">
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
            </div>
          ) : null}

          {competition.eligibilityNote ? (
            <section className="surface-card card-padding-lg stack-md">
              <div className="stack-xs">
                <p className="eyebrow">Informasi</p>
                <h2 className="section-title">Kelayakan</h2>
              </div>
              <p className="detail-description">{competition.eligibilityNote}</p>
            </section>
          ) : null}

          <section className="inset-panel card-padding-lg detail-organizer-card">
            {competition.organizer.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={competition.organizer.logoUrl}
                alt=""
                className="detail-organizer-logo"
                width={64}
                height={64}
              />
            ) : (
              <span
                className="detail-organizer-mark detail-organizer-mark-large"
                aria-hidden="true"
              >
                <Icon name="trophy" size="lg" />
              </span>
            )}
            <div className="stack-xs">
              <p className="eyebrow">Penyelenggara</p>
              <h2>{competition.organizer.name}</h2>
              <p className="muted-copy">
                {competition.organizer.about ??
                  "Informasi kompetisi dan tahapan partisipasi dikelola oleh penyelenggara ini."}
              </p>

              {hasOrganizerContact ? (
                <div className="detail-organizer-contact stack-xs">
                  <p className="eyebrow">Hubungi penyelenggara</p>
                  {competition.organizer.contactName ? (
                    <p>{competition.organizer.contactName}</p>
                  ) : null}
                  {competition.organizer.contactEmail ? (
                    <p>
                      <a href={`mailto:${competition.organizer.contactEmail}`}>
                        {competition.organizer.contactEmail}
                      </a>
                    </p>
                  ) : null}
                  {competition.organizer.contactPhone ? (
                    <p>{competition.organizer.contactPhone}</p>
                  ) : null}
                  {competition.organizer.websiteUrl ? (
                    <p>
                      <a
                        href={competition.organizer.websiteUrl}
                        target="_blank"
                        rel="noreferrer nofollow"
                      >
                        {competition.organizer.websiteUrl}
                      </a>
                    </p>
                  ) : null}
                  {competition.organizer.socialLinks.length > 0 ? (
                    <ul className="detail-organizer-socials cluster">
                      {competition.organizer.socialLinks.map((link) => (
                        <li key={link.platform}>
                          <a href={link.url} target="_blank" rel="noreferrer nofollow">
                            {SOCIAL_LABELS[link.platform] ?? formatDisplayToken(link.platform)}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section className="surface-card card-padding-lg stack-md">
            <div className="stack-xs">
              <p className="eyebrow">Ulasan peserta</p>
              <h2 className="section-title">Ulasan</h2>
              {reviewSummary.count > 0 ? (
                <p className="data-text">
                  ★ {reviewSummary.average?.toFixed(1)} · {reviewSummary.count} ulasan
                </p>
              ) : (
                <p className="muted-copy">Belum ada ulasan.</p>
              )}
            </div>

            {canReview ? (
              <CompetitionReviewForm
                competitionId={competition.id}
                expectedUserId={session!.user.id}
                initialReview={myReview ? { rating: myReview.rating, body: myReview.body } : null}
              />
            ) : isCandidate ? (
              <p className="muted-copy">Daftar dan ikuti kompetisi ini untuk memberi ulasan.</p>
            ) : !session?.user ? (
              <p className="detail-rail-note">
                <Link href="/auth/login">Masuk</Link> sebagai peserta untuk memberi ulasan.
              </p>
            ) : null}

            {reviews.length > 0 ? (
              <ul className="detail-review-list stack-sm">
                {reviews.map((review, index) => (
                  <li key={`${review.authorName}-${index}`} className="detail-review-item stack-xs">
                    <div className="cluster">
                      <strong aria-label={`${review.rating} dari 5 bintang`}>
                        {"★".repeat(review.rating)}
                        {"☆".repeat(5 - review.rating)}
                      </strong>
                      <span className="muted-copy">{review.authorName}</span>
                    </div>
                    {review.body ? <p>{review.body}</p> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </article>

        <aside className="glass-focus detail-cta-rail" aria-label="Ringkasan pendaftaran">
          <div className="stack-sm">
            <RegistrationStatus
              ctaState={competition.ctaState}
              registrationEndAt={competition.registrationEndAt}
            />
            <div className="stack-xs">
              <p className="eyebrow">Batas pendaftaran</p>
              <p className="detail-deadline data-text">
                {formatDateTime(competition.registrationEndAt)}
              </p>
            </div>
            <div className="stack-xs">
              <p className="eyebrow">Terdaftar</p>
              <p className="detail-deadline data-text">
                {competition.registrantCount.toLocaleString("id-ID")} peserta
              </p>
            </div>
            {competition.prizePoolTotal ? (
              <div className="stack-xs">
                <p className="eyebrow">Total hadiah</p>
                <p className="detail-deadline data-text">
                  Rp {competition.prizePoolTotal.toLocaleString("id-ID")}
                </p>
              </div>
            ) : null}
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

            <DetailActions
              competitionId={competition.id}
              title={competition.title}
              eventStartAt={
                competition.eventStartAt ? new Date(competition.eventStartAt).toISOString() : null
              }
              eventEndAt={
                competition.eventEndAt ? new Date(competition.eventEndAt).toISOString() : null
              }
              description={competition.description}
            />
          </div>
        </aside>
      </div>

      <CompetitionRail
        heading={`Lainnya dari ${competition.organizer.name}`}
        items={organizerRail}
      />
      <CompetitionRail heading="Kompetisi serupa" items={relatedRail} />
    </main>
  );
}
