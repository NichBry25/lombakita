"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useModal } from "@/components/ui/primitives";
import { CompetitionFilterSheet, type FilterSheetSection } from "./competition-filter-sheet";
import {
  CATEGORY_OPTIONS,
  CompetitionFilters,
  CompetitionPhoneFilters,
  SORT_OPTIONS,
  STATUS_OPTIONS,
} from "./competition-filters";
import type { TeamRange } from "@/lib/competitions/team-range";
import type { CompetitionSearchParams, FilterSelection } from "./search-params";
import {
  CLEAR_TEAM_RANGE_PARAMS,
  DROPPED_TEAM_PARAMS,
  competitionsHref,
  readFilterSelection,
  selectionToParams,
  teamRangeToParams,
} from "./search-params";

const CLEAR_EVERY_FILTER: Partial<CompetitionSearchParams> = {
  category: undefined,
  status: undefined,
  ...CLEAR_TEAM_RANGE_PARAMS,
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
 * It draws both layouts: the pill row for wide screens and the chip row for phones. CSS shows one
 * of them, so the server and the browser render the same markup.
 *
 * PENDING STATE. This route has no `loading.tsx`, because a route-level Suspense boundary makes
 * Next stream a skeleton into the shell and deliver the listing inside a hidden element that only
 * a script can reveal, which leaves a reader without JavaScript looking at a placeholder forever.
 * That is the defect this page was rewritten to remove. A navigation still has to show that it is
 * running, so the transition drives the spinner beside the controls and `aria-busy` on the row
 * that owns them.
 */
export function CompetitionFilterBar({
  params,
  total,
}: {
  params: CompetitionSearchParams;
  total: number;
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

  const navigate = (overrides: Partial<CompetitionSearchParams>) => {
    // A changed filter re-selects the result set, so the old page number no longer refers to
    // anything. Landing on page 4 of a two-page set shows an empty grid.
    const href = competitionsHref(params, { ...currentTeamParams, ...overrides, page: undefined });
    startTransition(() => router.push(href));
  };

  const applyTeamRange = (range: TeamRange) => {
    navigate(teamRangeToParams(range));
  };

  const applySheetSelection = (picked: FilterSelection) => {
    navigate(selectionToParams(picked));
    closeModal();
  };

  const toggleOpenStatus = () => {
    navigate({ status: selection.status === "open" ? undefined : "open" });
  };

  const openSheet = (openAtSection?: FilterSheetSection) => {
    openModal({
      title: "Filter",
      fullHeight: true,
      actions: [],
      body: (
        <CompetitionFilterSheet
          initial={selection}
          baseParams={params}
          initialTotal={total}
          categoryOptions={CATEGORY_OPTIONS}
          statusOptions={STATUS_OPTIONS}
          sortOptions={SORT_OPTIONS}
          openAtSection={openAtSection}
          onApply={applySheetSelection}
        />
      ),
    });
  };

  return (
    <>
      <CompetitionFilters
        isPending={isPending}
        selection={selection}
        onCategory={(category) => navigate({ category: category || undefined })}
        onStatus={(status) => navigate({ status: status || undefined })}
        onSort={(sort) => navigate({ sort: sort || undefined })}
        onTeamRange={applyTeamRange}
      />
      <CompetitionPhoneFilters
        isPending={isPending}
        selection={selection}
        onOpenSheet={openSheet}
        onToggleOpenStatus={toggleOpenStatus}
        onClearChip={navigate}
        onClearAll={() => navigate(CLEAR_EVERY_FILTER)}
      />
    </>
  );
}
