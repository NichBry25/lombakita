import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, ButtonLink, Icon } from "@/components/ui";
import { sessionHasRole } from "@/lib/access/roles";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";
import { getCompetitionCancellationReasonLabel } from "@/lib/competitions/competition-participation";
import {
  getCompetitionPhaseBadgeStatus,
  getCompetitionPhaseLabel,
  isAwaitingResultsPhase,
  resolveResultAnnouncement,
  type CompetitionPhase,
} from "@/lib/competitions/competition-phase";
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
import { loadInstitutionVerificationSummaryBySlug } from "@/server/institution-workspace/institution-service";
import { SaveButton } from "./save-button";
import { DetailActions } from "./detail-actions";
import { CompetitionReviewForm } from "./competition-review-form";
import { formatTeamSizeText } from "./team-size-utils";
import { isPaidCompetition } from "@/lib/competitions/paid-competition";

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

// The fee and its currency are read TOGETHER. `fee_amount` is an integer count of the currency's
// smallest unit (@/lib/finance/money), so the number alone does not say what it means. The same
// 50000 is Rp 50.000 under IDR's exponent 0 and $500.00 under USD's exponent 2. Formatting it
// without reading the currency beside it is the exact defect that convention exists to prevent,
// and it is why this surface previously showed a price the API never denominated.
function FeeDisplay({
  feeAmount,
  feeCurrency,
}: {
  feeAmount: number | null;
  feeCurrency: string | null;
}) {
  if (!isPaidCompetition(feeAmount)) {
    return <p className="detail-fee-free">Gratis</p>;
  }

  // Non-null once isPaidCompetition passes; the CHECK constraint requires a currency on any
  // priced competition, so the fallback is unreachable rather than a guess at what was meant.
  const currency = feeCurrency ?? "IDR";

  return (
    <div className="stack-xs">
      <p className="detail-fee-amount">
        {new Intl.NumberFormat("id-ID", {
          style: "currency",
          currency,
          maximumFractionDigits: 0,
        }).format(feeAmount as number)}
      </p>
      <p className="detail-rail-note">Pembayaran online segera hadir.</p>
    </div>
  );
}

function CTANavLink({
  ctaState,
  registrationPath,
  isCandidate,
  isCancelled,
}: {
  ctaState: PublicCompetitionDetail["ctaState"];
  registrationPath: string;
  isCandidate: boolean;
  isCancelled: boolean;
}) {
  if (isCancelled) {
    return (
      <Button disabled size="lg" fullWidth>
        Kompetisi dibatalkan
      </Button>
    );
  }
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

function getCompetitionPhaseDate(
  phase: CompetitionPhase,
  competition: Pick<
    PublicCompetitionDetail,
    | "registrationStartAt"
    | "registrationEndAt"
    | "eventStartAt"
    | "eventEndAt"
    | "resultAnnouncementAt"
    | "cancelledAt"
  >,
) {
  if (phase === "cancelled") return competition.cancelledAt;
  if (phase === "upcoming") return competition.registrationStartAt;
  if (
    phase === "registration_open" ||
    phase === "registration_closing" ||
    phase === "registration_closed"
  ) {
    return competition.registrationEndAt;
  }
  if (phase === "in_progress") return competition.eventStartAt;
  if (phase === "awaiting_results" || phase === "results_overdue") {
    return resolveResultAnnouncement(competition).at;
  }
  return competition.resultAnnouncementAt ?? competition.eventEndAt;
}

function CompetitionPhaseSummary({
  phase,
  phaseDate,
}: {
  phase: CompetitionPhase;
  phaseDate: Date | string | null;
}) {
  return (
    <div className="detail-phase-summary" data-status={getCompetitionPhaseBadgeStatus(phase)}>
      <p className="detail-phase-title">
        {getCompetitionPhaseLabel(phase)}
        {phaseDate ? `: ${formatDate(phaseDate)}` : ""}
      </p>
    </div>
  );
}

// The results block on the CTA rail. It exists so a participant whose competition has finished can
// see whether an outcome is still owed and when it was promised, rather than being left with a
// page that simply stops. Deliberately neutral: it reports that results have not been announced,
// never how late they are.
function ResultAnnouncementSummary({
  phase,
  resultAnnouncementAt,
  eventEndAt,
}: {
  phase: CompetitionPhase;
  resultAnnouncementAt: Date | string | null;
  eventEndAt: Date | string | null;
}) {
  if (phase === "results_announced") {
    return (
      <div className="stack-xs">
        <p className="eyebrow">Hasil</p>
        <p className="detail-deadline data-text">Sudah diumumkan</p>
      </div>
    );
  }

  if (!isAwaitingResultsPhase(phase)) return null;

  const announcement = resolveResultAnnouncement({ resultAnnouncementAt, eventEndAt });

  // A date the organizer typed is a commitment; one inferred from the event end is only an
  // estimate, and must not be presented as something they promised.
  const heading = announcement.source === "declared" ? "Pengumuman hasil" : "Perkiraan hasil";

  return (
    <div className="stack-xs">
      <p className="eyebrow">{heading}</p>
      <p className="detail-deadline data-text">
        {announcement.at ? formatDateTime(announcement.at) : "Belum dijadwalkan"}
      </p>
      {phase === "results_overdue" ? (
        <p className="form-hint">
          Hasil belum diumumkan. Kunjungi profil penyelenggara bila Anda membutuhkan kepastian.
        </p>
      ) : null}
    </div>
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
  const [competition, session, institutionVerification] = await Promise.all([
    getPublicCompetitionDetail(institutionSlug, slug),
    getCurrentSession(),
    loadInstitutionVerificationSummaryBySlug(institutionSlug),
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
  const organizerIsVerified = institutionVerification?.verificationStatus === "verified";
  const competitionPhaseDate = getCompetitionPhaseDate(competition.phase, competition);

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
            Kompetisi
          </Link>

          <div className="detail-hero-content stack-md">
            <h1>{competition.title}</h1>

            <div className="cluster">
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

            <div className="detail-organizer-line">
              {competition.organizer.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={competition.organizer.logoUrl} alt="" />
              ) : (
                <span className="detail-organizer-mark" aria-hidden="true">
                  <Icon name="trophy" size="sm" />
                </span>
              )}
              <span>
                Diselenggarakan oleh{" "}
                <Link
                  href={`/institution/${competition.organizer.slug}`}
                  className="detail-organizer-link"
                >
                  {competition.organizer.name}
                </Link>
              </span>
            </div>
          </div>
        </div>
      </section>

      <div className="page-shell detail-layout">
        <article className="detail-main stack-lg">
          {competition.cancelledAt ? (
            <section
              className="feedback stack-xs"
              data-tone="error"
              aria-labelledby="cancelled-title"
            >
              <h2 id="cancelled-title">Kompetisi dibatalkan</h2>
              <p>
                {getCompetitionCancellationReasonLabel(competition.cancellationReason) ??
                  "Kompetisi ini tidak akan dilaksanakan."}
              </p>
              <p className="data-text">Dibatalkan pada {formatDateTime(competition.cancelledAt)}</p>
            </section>
          ) : null}

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

          <section
            className="inset-panel card-padding detail-verification-panel"
            data-verified={organizerIsVerified ? "true" : "false"}
            aria-labelledby="organizer-verification-title"
          >
            <span className="detail-verification-icon" aria-hidden="true">
              <Icon name={organizerIsVerified ? "check" : "info"} size="md" />
            </span>
            <div className="stack-xs">
              <p className="eyebrow">Status penyelenggara</p>
              <h2 id="organizer-verification-title">
                {organizerIsVerified ? "Institusi terverifikasi" : "Belum terverifikasi"}
              </h2>
              <p>
                {organizerIsVerified
                  ? "Identitas institusi ini telah ditinjau oleh tim Lombakita."
                  : "Institusi ini belum memperoleh verifikasi dari tim Lombakita."}
              </p>
            </div>
          </section>
        </article>

        <aside className="glass-focus detail-cta-rail" aria-label="Ringkasan pendaftaran">
          <div className="detail-rail-summary">
            <CompetitionPhaseSummary phase={competition.phase} phaseDate={competitionPhaseDate} />
            <div className="stack-xs">
              <p className="eyebrow">Batas pendaftaran</p>
              <p className="detail-deadline data-text">
                {formatDateTime(competition.registrationEndAt)}
              </p>
            </div>
            <ResultAnnouncementSummary
              phase={competition.phase}
              resultAnnouncementAt={competition.resultAnnouncementAt}
              eventEndAt={competition.eventEndAt}
            />
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
            <FeeDisplay feeAmount={competition.feeAmount} feeCurrency={competition.feeCurrency} />
          </div>
          <div className="detail-rail-actions">
            <div className="detail-primary-actions">
              <CTANavLink
                ctaState={competition.ctaState}
                registrationPath={registrationPath}
                isCandidate={isCandidate}
                isCancelled={competition.cancelledAt !== null}
              />
              {isCandidate ? (
                <SaveButton
                  competitionId={competition.id}
                  initialSaved={initialSaved}
                  expectedUserId={session!.user.id}
                />
              ) : null}
            </div>
            {!session?.user ? (
              <p className="detail-rail-note">
                <Link href="/auth/login">Masuk</Link> sebagai mahasiswa untuk mendaftar.
              </p>
            ) : null}
            {session?.user && !isCandidate ? (
              <p className="detail-rail-note">Hanya akun kandidat yang dapat mendaftar.</p>
            ) : null}

            {!isCandidate ? (
              <p className="detail-rail-note">
                <Link href="/auth/login">Masuk</Link> untuk menyimpan kompetisi ini.
              </p>
            ) : null}

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
