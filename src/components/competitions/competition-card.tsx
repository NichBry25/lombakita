import Link from "next/link";
import { Icon } from "@/components/ui";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";
import {
  deriveCompetitionPhase,
  getCompetitionPhaseBadgeStatus,
  getCompetitionPhaseLabel,
  resolveResultAnnouncement,
  type CompetitionPhase,
} from "@/lib/competitions/competition-phase";

// One competition in a grid. Presentational and dependency-free beyond routing, so the public
// listing (a client component) and the institution page (a server component) render the same card
// rather than each keeping their own copy of the markup.
//
// Dates arrive as strings or Dates depending on whether the caller came through the JSON API or
// read the database directly.
export type CompetitionCardItem = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  mode: string | null;
  isFeatured: boolean;
  registrationStartAt: string | Date | null;
  registrationEndAt: string | Date | null;
  eventStartAt: string | Date | null;
  eventEndAt: string | Date | null;
  resultAnnouncementAt: string | Date | null;
  cancelledAt: string | Date | null;
  hasPublishedResult: boolean;
  institutionSlug: string;
  institutionName: string;
};

const DESCRIPTION_MAX_LENGTH = 160;

export function formatDeadline(value: string | Date | null): string {
  if (!value) return "Tanpa batas waktu";
  return new Date(value).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// The date worth showing next to the phase. Before the event that is the registration deadline;
// once the event is over it is the promised announcement date, which is the only date a waiting
// participant still cares about. Null when the phase has no date to offer.
function resolvePhaseDate(
  phase: CompetitionPhase,
  competition: CompetitionCardItem,
): string | Date | null {
  if (phase === "cancelled") return competition.cancelledAt;
  if (phase === "awaiting_results" || phase === "results_overdue") {
    return resolveResultAnnouncement(competition).at;
  }
  if (phase === "results_announced" || phase === "in_progress") return null;
  return competition.registrationEndAt;
}

function truncateDescription(description: string): string {
  return description.length > DESCRIPTION_MAX_LENGTH
    ? `${description.slice(0, DESCRIPTION_MAX_LENGTH)}…`
    : description;
}

export function CompetitionCard({
  competition,
  showOrganizer = true,
}: {
  competition: CompetitionCardItem;
  // The organizer's own page already names the organizer in its header, so repeating it on every
  // card is noise.
  showOrganizer?: boolean;
}) {
  const detailPath = `/competitions/${competition.institutionSlug}/${competition.slug}`;
  const phase = deriveCompetitionPhase(competition);
  const phaseDate = resolvePhaseDate(phase, competition);

  return (
    <article className="competition-card">
      <Link
        href={detailPath}
        className="competition-cover"
        data-category={competition.category ?? "other"}
        aria-label={`Buka ${competition.title}`}
      >
        <span className="competition-cover-icon" aria-hidden="true">
          <Icon name="trophy" size="lg" />
        </span>
        <span className="competition-cover-label">
          {competition.category ? getCompetitionCategoryLabel(competition.category) : "Kompetisi"}
        </span>
      </Link>

      <div className="competition-card-body">
        <div className="competition-card-badges">
          {competition.isFeatured ? (
            <span className="status-badge" data-status="featured">
              Pilihan Editor
            </span>
          ) : null}
          {competition.mode ? (
            <span className="status-badge">{getCompetitionModeLabel(competition.mode)}</span>
          ) : null}
        </div>

        <div className="stack-xs">
          <Link href={detailPath} className="competition-title-link">
            {competition.title}
          </Link>
          {showOrganizer ? (
            <p className="competition-organizer">{competition.institutionName}</p>
          ) : null}
        </div>

        {competition.description ? (
          <p className="competition-description">{truncateDescription(competition.description)}</p>
        ) : null}

        <div className="competition-card-footer">
          <span className="status-badge" data-status={getCompetitionPhaseBadgeStatus(phase)}>
            {getCompetitionPhaseLabel(phase)}
            {phaseDate ? ` · ${formatDeadline(phaseDate)}` : ""}
          </span>
          <span className="competition-card-arrow" aria-hidden="true">
            <Icon name="arrow-right" size="md" />
          </span>
        </div>
      </div>
    </article>
  );
}
