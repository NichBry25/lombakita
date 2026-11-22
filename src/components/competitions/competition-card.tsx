"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon, LinkPendingSlot } from "@/components/ui";
import { LocalDate } from "@/components/ui/local-date";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionLocationLabel } from "@/lib/competitions/locations";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";
import {
  deriveCompetitionPhase,
  getCompetitionPhaseBadgeStatus,
  getCompetitionPhaseCardLabel,
  resolveResultAnnouncement,
  type CompetitionPhase,
} from "@/lib/competitions/competition-phase";

// One competition in a grid. Presentational and dependency-free beyond routing, so the home
// featured row, the public listing, the institution page and the detail page's rails render the
// same card rather than each keeping their own copy of the markup. A client module because a logo
// that fails to load swaps itself for the trophy.
//
// Dates arrive as strings or Dates depending on whether the caller came through the JSON API or
// read the database directly.
export type CompetitionCardItem = {
  id: string;
  slug: string;
  title: string;
  category: string | null;
  mode: string | null;
  location: string | null;
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

// The badge is var(--touch-target), 2.75rem, which is 44 px at the default root size.
const COVER_BADGE_SIZE_PX = 44;

// The organizer is named in the text under the title, so the logo carries no alt text of its own.
// A signed address can expire while a cached page is still served, so a logo that fails to load
// gives way to the trophy rather than leaving the badge empty.
function CoverBadgeGlyph({ logoUrl }: { logoUrl: string | null }) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  if (!logoUrl || failedLogoUrl === logoUrl) return <Icon name="trophy" size="lg" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt=""
      width={COVER_BADGE_SIZE_PX}
      height={COVER_BADGE_SIZE_PX}
      loading="lazy"
      decoding="async"
      className="competition-cover-logo"
      onError={() => setFailedLogoUrl(logoUrl)}
    />
  );
}

export function CompetitionCard({ competition }: { competition: CompetitionCardItem }) {
  const detailPath = `/competitions/${competition.institutionSlug}/${competition.slug}`;
  const phase = deriveCompetitionPhase(competition);
  const phaseDate = resolvePhaseDate(phase, competition);
  const locationLabel = getCompetitionLocationLabel(competition.location);

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
          {locationLabel ? <span className="status-badge">{locationLabel}</span> : null}
        </div>

        <div className="stack-xs">
          {/* Its own signal rather than relying on the cover's: `useLinkStatus` reports only the
              navigation its enclosing Link started, so a click on the title would otherwise
              acknowledge nothing. */}
          <Link href={detailPath} className="competition-title-link">
            <span className="competition-title-text">{competition.title}</span>
            <LinkPendingSlot />
          </Link>
          <p className="competition-organizer">{competition.institutionName}</p>
        </div>

        <div className="competition-card-footer">
          <span className="status-badge" data-status={getCompetitionPhaseBadgeStatus(phase)}>
            {getCompetitionPhaseCardLabel(phase)}
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
