import Link from "next/link";
import { Icon, LinkPendingSlot } from "@/components/ui";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import type { DeadlineCountdown } from "@/lib/competitions/deadline-countdown";

// One competition in a homepage row. Smaller than the listing's CompetitionCard so a row shows
// several at once, and it leads with the countdown rather than the description: in a row the
// reader is choosing what to open, and how long is left is what makes one worth opening now.
//
// Plain data with the countdown already worked out, so the server can build the rows' props and
// the client rows (recently viewed, picked for you) can build the same shape from storage.
export type ShelfItem = {
  id: string;
  slug: string;
  institutionSlug: string;
  title: string;
  institutionName: string;
  category: string | null;
  countdown: DeadlineCountdown | null;
};

export function CompetitionPosterCard({ item }: { item: ShelfItem }) {
  const detailPath = `/competitions/${item.institutionSlug}/${item.slug}`;

  return (
    <article className="poster-card">
      <Link
        href={detailPath}
        className="competition-cover poster-card-cover"
        data-category={item.category ?? "other"}
        aria-label={`Buka ${item.title}`}
        tabIndex={-1}
      >
        <span className="competition-cover-icon" aria-hidden="true">
          <LinkPendingSlot leadingIcon={<Icon name="trophy" size="md" />} />
        </span>
        <span className="competition-cover-label">
          {item.category ? getCompetitionCategoryLabel(item.category) : "Kompetisi"}
        </span>
      </Link>

      <div className="poster-card-body">
        {/* The title is the card's one tab stop; the cover above repeats it for pointer users. */}
        <Link href={detailPath} className="poster-card-title">
          {item.title}
          <LinkPendingSlot />
        </Link>
        <p className="poster-card-organizer">{item.institutionName}</p>
        {item.countdown ? (
          <span className="status-badge poster-card-countdown" data-status={item.countdown.tone}>
            {item.countdown.label}
          </span>
        ) : null}
      </div>
    </article>
  );
}
