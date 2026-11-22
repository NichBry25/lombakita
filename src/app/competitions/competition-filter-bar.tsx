"use client";

import { useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui";
import { useModal } from "@/components/ui/primitives";
import { CompetitionFilterSheet, type FilterSheetSection } from "./competition-filter-sheet";
import {
  CATEGORY_OPTIONS,
  CompetitionFilters,
  CompetitionPhoneFilters,
  LOCATION_OPTIONS,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  sectionToOpenForFilterPill,
} from "./competition-filters";
import type { CompetitionSearchParams, FilterSelection } from "./search-params";
import {
  CLEAR_FEE_PARAMS,
  CLEAR_TEAM_RANGE_PARAMS,
  DROPPED_TEAM_PARAMS,
  competitionsHref,
  feeRangeToParams,
  readFilterSelection,
  selectionToParams,
  teamRangeToParams,
} from "./search-params";

const CLEAR_EVERY_FILTER: Partial<CompetitionSearchParams> = {
  category: undefined,
  status: undefined,
  location: undefined,
  audience: undefined,
  ...CLEAR_TEAM_RANGE_PARAMS,
  ...CLEAR_FEE_PARAMS,
};

/**
 * The filter row, wired to the URL rather than to local state.
 *
 * The page reads its filters from the query string on the server, so a change here has to land in
 * the URL for anything to happen. That is also what makes a filtered view shareable, reloadable
 * and crawlable: the address bar holds the whole state of the page.
 *
 * The applied filters arrive as props rather than from `useSearchParams`, so this component reads
 * the same values the server rendered from and does not have to re-derive them.
 *
 * It draws both layouts: the pill row for wide screens and the bar at the bottom of the screen for
 * phones. CSS shows one of them, so the server and the browser render the same markup. The bar
 * sits outside the glass toolbar because a backdrop filter would make the toolbar, and not the
 * screen, the box that "fixed" is measured against.
 *
 * PENDING STATE. This route has no `loading.tsx`, because a route-level Suspense boundary makes
 * Next stream a skeleton into the shell and deliver the listing inside a hidden element that only
 * a script can reveal, which leaves a reader without JavaScript looking at a placeholder forever.
 * That is the defect this page was rewritten to remove. A navigation still has to show that it is
 * running, so the transition drives the spinner at the end of the result count line and
 * `aria-busy` on the row that owns the controls. The phone bar shows its own spinner after its
 * scrolling chip row, so it stays on screen however far the chips are scrolled. Neither spinner
 * sits inside the controls it follows, so no control's width changes while a navigation runs.
 */
export function CompetitionFilterBar({
  params,
  resultCount,
}: {
  params: CompetitionSearchParams;
  // The line that says how many competitions were found, drawn above the desktop row.
  resultCount: ReactNode;
}) {
  const router = useRouter();
  const { openModal, closeModal } = useModal();
  const [isPending, startTransition] = useTransition();
  const selection = readFilterSelection(params);

  // The range the page shows, written back as teamMin and teamMax with `mode` and `teamSize`
  // removed, so any change from an old link leaves only the new parameters in the address.
  const currentTeamParams = {
    ...DROPPED_TEAM_PARAMS,
    ...teamRangeToParams(selection.teamRange),
  };

  // The fee range the page shows, written back so an unreadable fee value does not ride along
  // after another filter changes.
  const currentFeeParams = feeRangeToParams(selection.feeRange);

  const navigate = (overrides: Partial<CompetitionSearchParams>) => {
    // A changed filter re-selects the result set, so the old page number no longer refers to
    // anything. Landing on page 4 of a two-page set shows an empty grid.
    const href = competitionsHref(params, {
      ...currentTeamParams,
      ...currentFeeParams,
      ...overrides,
      page: undefined,
    });
    startTransition(() => router.push(href));
  };

  const clearEveryFilter = () => {
    navigate(CLEAR_EVERY_FILTER);
  };

  const toggleOnlineLocation = () => {
    navigate({ location: selection.location === "online" ? undefined : "online" });
  };

  // The panel closes first so the page behind it is what shows the transition's pending signals.
  const applySheetSelection = (picked: FilterSelection) => {
    closeModal();
    navigate(selectionToParams(picked));
  };

  const toggleOpenStatus = () => {
    navigate({ status: selection.status === "open" ? undefined : "open" });
  };

  const openPanel = (openAtSection: FilterSheetSection, focusSection?: FilterSheetSection) => {
    openModal({
      title: "Filter",
      fullHeight: true,
      drawer: true,
      actions: [],
      body: (
        <CompetitionFilterSheet
          initial={selection}
          categoryOptions={CATEGORY_OPTIONS}
          locationOptions={LOCATION_OPTIONS}
          statusOptions={STATUS_OPTIONS}
          sortOptions={SORT_OPTIONS}
          openAtSection={openAtSection}
          focusSection={focusSection}
          onApply={applySheetSelection}
        />
      ),
    });
  };

  const openPanelFromFilterPill = () => {
    openPanel(sectionToOpenForFilterPill(selection));
  };

  const openPanelFromSectionChip = (section: FilterSheetSection) => {
    openPanel(section, section);
  };

  return (
    <>
      <div className="glass-chrome filter-toolbar">
        <div className="filter-result-line">
          {resultCount}
          {isPending ? <Spinner size="sm" className="filter-result-spinner" /> : null}
        </div>
        <CompetitionFilters
          isPending={isPending}
          selection={selection}
          onCategory={(category) => navigate({ category: category || undefined })}
          onStatus={(status) => navigate({ status: status || undefined })}
          onLocation={(location) => navigate({ location: location || undefined })}
          onSort={(sort) => navigate({ sort: sort || undefined })}
          onOpenPanel={openPanelFromFilterPill}
          onClearAll={clearEveryFilter}
        />
      </div>
      <CompetitionPhoneFilters
        isPending={isPending}
        selection={selection}
        onOpenPanel={openPanelFromFilterPill}
        onOpenSection={openPanelFromSectionChip}
        onToggleOpenStatus={toggleOpenStatus}
        onToggleOnlineLocation={toggleOnlineLocation}
      />
    </>
  );
}
