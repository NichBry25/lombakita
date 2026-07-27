import { Icon } from "./icon";
import { IconButton, IconButtonLink } from "./button";

type PaginationBaseProps = {
  page: number;
  totalPages: number;
  // Localized accessible name for the surrounding nav, e.g. "Halaman peserta".
  label: string;
};

type PaginationProps = PaginationBaseProps &
  (
    | { hrefFor: (page: number) => string; onPageChange?: never }
    | { onPageChange: (page: number) => void; hrefFor?: never }
  );

const PREVIOUS_LABEL = "Sebelumnya";
const NEXT_LABEL = "Selanjutnya";

// An anchor cannot be disabled, so an unavailable step renders as an inert span that keeps the
// control's footprint and its accessible name rather than disappearing and shifting the row.
function InertStep({ direction }: { direction: "previous" | "next" }) {
  const label = direction === "previous" ? PREVIOUS_LABEL : NEXT_LABEL;
  return (
    <span
      className="ui-icon-button"
      data-variant="outline"
      data-size="sm"
      aria-disabled="true"
      aria-label={label}
      title={label}
    >
      <Icon name={direction === "previous" ? "arrow-left" : "arrow-right"} />
    </span>
  );
}

/**
 * The single pagination control for every paged surface. It exists in two modes because the app
 * pages in two ways: server components step through URLs (`hrefFor`) and keep their pending state
 * from the route skeleton, while client components step through local state (`onPageChange`).
 */
export function Pagination({ page, totalPages, label, hrefFor, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav className="pagination" aria-label={label}>
      {hrefFor ? (
        hasPrevious ? (
          <IconButtonLink
            href={hrefFor(page - 1)}
            icon="arrow-left"
            label={PREVIOUS_LABEL}
            variant="outline"
            size="sm"
          />
        ) : (
          <InertStep direction="previous" />
        )
      ) : (
        <IconButton
          icon="arrow-left"
          label={PREVIOUS_LABEL}
          variant="outline"
          size="sm"
          disabled={!hasPrevious}
          onClick={() => onPageChange?.(page - 1)}
        />
      )}

      <span className="pagination-status data-text">
        Halaman {page} dari {totalPages}
      </span>

      {hrefFor ? (
        hasNext ? (
          <IconButtonLink
            href={hrefFor(page + 1)}
            icon="arrow-right"
            label={NEXT_LABEL}
            variant="outline"
            size="sm"
          />
        ) : (
          <InertStep direction="next" />
        )
      ) : (
        <IconButton
          icon="arrow-right"
          label={NEXT_LABEL}
          variant="outline"
          size="sm"
          disabled={!hasNext}
          onClick={() => onPageChange?.(page + 1)}
        />
      )}
    </nav>
  );
}
