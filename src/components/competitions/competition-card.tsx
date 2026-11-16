import Link from "next/link";
import { Icon, LinkPendingSlot } from "@/components/ui";
import { LocalDate } from "@/components/ui/local-date";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";
import {
  deriveCompetitionPhase,
  getCompetitionPhaseBadgeStatus,
  getCompetitionPhaseLabel,
  resolveResultAnnouncement,
  type CompetitionPhase,
} from "@/lib/competitions/competition-phase";

// One competition in a grid. Presentational and dependency-free beyond routing, so the home
// featured row (a client component), the public listing and the institution page (server
// components) render the same card rather than each keeping their own copy of the markup.
//
// Dates arrive as strings or Dates depending on whether the caller came through the JSON API or
// read the database directly.
export type CompetitionCardItem = {
  id: string;
  slug: string;
  title: string;
  category: string | null;
  mode: string | null;
  registrationStartAt: string | Date | null;
  registrationEndAt: string | Date | null;
  eventStartAt: string | Date | null;
  eventEndAt: string | Date | null;
  resultAnnouncementAt: string | Date | null;
  cancelledAt: string | Date | null;
  hasPublishedResult: boolean;
  institutionSlug: string;
  institutionName: string;
  institutionLogoUrl: string | null;
};

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

// The organizer is named in the text under the title, so the logo carries no alt text of its own.
function CoverBadgeGlyph({ logoUrl }: { logoUrl: string | null }) {
  if (!logoUrl) return <Icon name="trophy" size="lg" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={logoUrl} alt="" className="competition-cover-logo" />;
}

export function CompetitionCard({ competition }: { competition: CompetitionCardItem }) {
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
        {/* The competition detail route has no `loading.tsx` — it cannot have one without
            streaming its body out of the initial shell — so the pending signal for this navigation
            lives here, on the control that starts it (§14). The badge's slot is a fixed-size
            centred grid cell, so the spinner replaces the logo or trophy with no layout shift. */}
        <span className="competition-cover-icon" aria-hidden="true">
          <LinkPendingSlot
            leadingIcon={<CoverBadgeGlyph logoUrl={competition.institutionLogoUrl} />}
          />
        </span>
        <span className="competition-cover-label">
          {competition.category ? getCompetitionCategoryLabel(competition.category) : "Kompetisi"}
        </span>
      </Link>

      <div className="competition-card-body">
        <div className="competition-card-badges">
          {competition.mode ? (
            <span className="status-badge">{getCompetitionModeLabel(competition.mode)}</span>
          ) : null}
        </div>

        <div className="stack-xs">
          {/* Its own signal rather than relying on the cover's: `useLinkStatus` reports only the
              navigation its enclosing Link started, so a click on the title would otherwise
              acknowledge nothing. */}
          <Link href={detailPath} className="competition-title-link">
            {competition.title}
            <LinkPendingSlot />
          </Link>
          <p className="competition-organizer">{competition.institutionName}</p>
        </div>

        <div className="competition-card-footer">
          <span className="status-badge" data-status={getCompetitionPhaseBadgeStatus(phase)}>
            {getCompetitionPhaseLabel(phase)}
            {phaseDate ? (
              <>
                {" "}
                · <LocalDate value={phaseDate} format="shortDate" />
              </>
            ) : (
              ""
            )}
          </span>
        </div>
      </div>
    </article>
  );
}
