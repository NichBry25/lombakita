import Link from "next/link";
import { Icon } from "@/components/ui";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";

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
  registrationEndAt: string | Date | null;
  institutionSlug: string;
  institutionName: string;
};

const DESCRIPTION_MAX_LENGTH = 160;
const CLOSING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

export function formatDeadline(value: string | Date | null): string {
  if (!value) return "Tanpa batas waktu";
  return new Date(value).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// "Closing soon" is under seven days, per the brand book's status-badge rule.
export function resolveRegistrationStatus(value: string | Date | null) {
  if (!value) return { value: "open", label: "Dibuka" } as const;

  const millisecondsRemaining = new Date(value).getTime() - Date.now();
  if (millisecondsRemaining <= 0) return { value: "closed", label: "Ditutup" } as const;
  if (millisecondsRemaining < CLOSING_SOON_MS) {
    return { value: "closing", label: "Segera ditutup" } as const;
  }
  return { value: "open", label: "Dibuka" } as const;
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
  const registrationStatus = resolveRegistrationStatus(competition.registrationEndAt);

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
              Pilihan editor
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
          <span className="status-badge" data-status={registrationStatus.value}>
            {registrationStatus.label} · {formatDeadline(competition.registrationEndAt)}
          </span>
          <span className="competition-card-arrow" aria-hidden="true">
            <Icon name="arrow-right" size="md" />
          </span>
        </div>
      </div>
    </article>
  );
}
