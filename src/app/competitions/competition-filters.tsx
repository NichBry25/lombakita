"use client";

import {
  CheckboxField,
  FilterDropdown,
  Icon,
  IconButton,
  RangeSlider,
  Spinner,
  type FilterOption,
} from "@/components/ui";
import { COMPETITION_AUDIENCE_OPTIONS, formatAudienceLabels } from "@/lib/competitions/audiences";
import { COMPETITION_CATEGORY_OPTIONS } from "@/lib/competitions/categories";
import { COMPETITION_LOCATION_OPTIONS } from "@/lib/competitions/locations";
import type { CompetitionAudience } from "@/server/db/schema";
import type { FilterSheetSection } from "./competition-filter-sheet";
import {
  ANY_FEE_FILTER,
  FEE_HIGHEST,
  FEE_LOWEST,
  FEE_STEP,
  FEE_UPPER_END_LOWEST,
  FULL_FEE_RANGE,
  type FeeFilter,
  type FeeRange,
} from "@/lib/competitions/fee-range";
import { isTeamRangeNarrowed } from "@/lib/competitions/team-range";
import {
  DEFAULT_SORT,
  describeFeeAmount,
  describeFeeRange,
  describeFeeValue,
  describeTeamRange,
  type FilterSelection,
} from "./search-params";

export const CATEGORY_OPTIONS: FilterOption[] = [
  { value: "", label: "Semua kategori" },
  ...COMPETITION_CATEGORY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
];

export const LOCATION_OPTIONS: FilterOption[] = [
  { value: "", label: "Semua lokasi" },
  ...COMPETITION_LOCATION_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
];

// The default ("") hides competitions whose registration deadline has passed, so it is labelled
// for what it actually shows. "all" is the explicit opt-in that also surfaces finished
// competitions — their pages stay published, so they remain findable rather than disappearing.
export const STATUS_OPTIONS: FilterOption[] = [
  { value: "", label: "Masih berjalan" },
  { value: "upcoming", label: "Akan datang" },
  { value: "open", label: "Dibuka" },
  { value: "closing", label: "Segera ditutup" },
  { value: "closed", label: "Ditutup" },
  { value: "all", label: "Semua termasuk selesai" },
];

export const SORT_OPTIONS: FilterOption[] = [
  { value: "created_desc", label: "Terbaru" },
  { value: "deadline_asc", label: "Deadline terdekat" },
  { value: "deadline_desc", label: "Deadline terjauh" },
];

const OPEN_STATUS = "open";
const ONLINE_LOCATION = "online";

type AudienceChecklistProps = {
  idPrefix: string;
  ticked: readonly CompetitionAudience[];
  onToggle: (level: CompetitionAudience, isTicked: boolean) => void;
};

/** Umum ticked and fixed, then one tick box per level. Used by the filter panel. */
export function AudienceChecklist({ idPrefix, ticked, onToggle }: AudienceChecklistProps) {
  return (
    <div role="group" aria-label="Untuk" className="filter-checks">
      {COMPETITION_AUDIENCE_OPTIONS.map((option) =>
        option.value === "umum" ? (
          <CheckboxField key={option.value} id={`${idPrefix}-${option.value}`} checked disabled>
            {option.label}
          </CheckboxField>
        ) : (
          <CheckboxField
            key={option.value}
            id={`${idPrefix}-${option.value}`}
            checked={ticked.includes(option.value)}
            onChange={(event) => onToggle(option.value, event.target.checked)}
          >
            {option.label}
          </CheckboxField>
        ),
      )}
    </div>
  );
}

type FeeFilterControlsProps = {
  value: FeeFilter;
  onChange: (fee: FeeFilter) => void;
};

const FEE_CHOICES = [
  { kind: "free", label: "Gratis" },
  { kind: "paid", label: "Berbayar" },
] as const;

/**
 * The two fee choices and, under Berbayar, the price range. Pressing the chosen choice again takes
 * the filter off. Used by the filter panel.
 */
export function FeeFilterControls({ value, onChange }: FeeFilterControlsProps) {
  const toggleChoice = (kind: "free" | "paid") => {
    if (value.kind === kind) {
      onChange(ANY_FEE_FILTER);
      return;
    }
    onChange(kind === "free" ? { kind: "free" } : { kind: "paid", ...FULL_FEE_RANGE });
  };

  const changeRange = (range: FeeRange) => onChange({ kind: "paid", ...range });

  return (
    <div className="filter-fee">
      <div role="group" aria-label="Biaya" className="filter-sheet-options">
        {FEE_CHOICES.map((choice) => {
          const isSelected = value.kind === choice.kind;
          return (
            <button
              key={choice.kind}
              type="button"
              aria-pressed={isSelected}
              className="filter-dropdown-option filter-sheet-option"
              data-selected={isSelected ? "true" : undefined}
              onClick={() => toggleChoice(choice.kind)}
            >
              <span>{choice.label}</span>
              <span className="filter-dropdown-option-check" aria-hidden="true">
                {isSelected ? <Icon name="check" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      {value.kind === "paid" ? (
        <RangeSlider
          floor={FEE_LOWEST}
          ceiling={FEE_HIGHEST}
          step={FEE_STEP}
          maxHandleLowest={FEE_UPPER_END_LOWEST}
          value={{ min: value.min, max: value.max }}
          onChange={changeRange}
          label="Rentang biaya"
          minHandleLabel="Biaya minimum"
          maxHandleLabel="Biaya maksimum"
          summary={describeFeeRange(value)}
          describeValue={describeFeeAmount}
        />
      ) : null}
    </div>
  );
}

export type SetFilter = {
  section: FilterSheetSection;
  // The filter in words, without the name of its section.
  value: string;
};

const labelOfOption = (options: FilterOption[], value: string): string =>
  options.find((option) => option.value === value)?.label ?? value;

/**
 * One entry per filter that is set, in the order of the panel's sections. Sort is a way of
 * ordering and not a filter, so it has no entry.
 */
export const listSetFilters = (selection: FilterSelection): SetFilter[] => {
  const filters: SetFilter[] = [];
  if (selection.category !== "") {
    filters.push({
      section: "category",
      value: labelOfOption(CATEGORY_OPTIONS, selection.category),
    });
  }
  if (isTeamRangeNarrowed(selection.teamRange)) {
    filters.push({ section: "team", value: describeTeamRange(selection.teamRange) });
  }
  if (selection.location !== "") {
    filters.push({
      section: "location",
      value: labelOfOption(LOCATION_OPTIONS, selection.location),
    });
  }
  if (selection.audience.length > 0) {
    filters.push({ section: "audience", value: formatAudienceLabels(selection.audience) });
  }
  const feeValue = describeFeeValue(selection.fee);
  if (feeValue !== undefined) {
    filters.push({ section: "fee", value: feeValue });
  }
  if (selection.status !== "") {
    filters.push({ section: "status", value: labelOfOption(STATUS_OPTIONS, selection.status) });
  }
  return filters;
};

/** The sort in words when it is not the default, else undefined. Sort has no entry in the list above. */
export const describeNonDefaultSort = (sort: string): string | undefined =>
  sort === DEFAULT_SORT ? undefined : labelOfOption(SORT_OPTIONS, sort);

/** The section the Filter pill opens the panel on: the first with a filter set, else Kategori. */
export const sectionToOpenForFilterPill = (selection: FilterSelection): FilterSheetSection =>
  listSetFilters(selection)[0]?.section ?? "category";

type FilterPillProps = {
  count: number;
  className: string;
  onClick: () => void;
};

// The Filter pill of the desktop row and of the phone bar. The number is how many filters are set,
// and the accessible name carries it so a screen reader does not hear a bare digit after "Filter".
function FilterPill({ count, className, onClick }: FilterPillProps) {
  const hasSetFilters = count > 0;
  return (
    <button
      type="button"
      className={className}
      data-active={hasSetFilters ? "true" : undefined}
      aria-haspopup="dialog"
      aria-label={hasSetFilters ? `Filter (${count})` : undefined}
      onClick={onClick}
    >
      <Icon name="sliders" />
      Filter
      {hasSetFilters ? (
        <span className="filter-count-badge" aria-hidden="true">
          {count}
        </span>
      ) : null}
    </button>
  );
}

type CompetitionFiltersProps = {
  selection: FilterSelection;
  // A filter change navigates, and this row is the control that owns that navigation, so it
  // carries the busy state and shows the spinner while the next result set is being fetched.
  isPending?: boolean;
  onCategory: (value: string) => void;
  onStatus: (value: string) => void;
  onLocation: (value: string) => void;
  onSort: (value: string) => void;
  onOpenPanel: () => void;
  onClearAll: () => void;
};

/**
 * The desktop row: Kategori, Status and Lokasi in front, the Filter pill that opens the panel with
 * every filter, a trash button that shows while a filter is set, and Urutkan at the right end. It
 * never wraps. Below 928 px it is hidden and the bar at the bottom of the screen takes its place.
 */
export function CompetitionFilters({
  selection,
  isPending = false,
  onCategory,
  onStatus,
  onLocation,
  onSort,
  onOpenPanel,
  onClearAll,
}: CompetitionFiltersProps) {
  const setFilterCount = listSetFilters(selection).length;

  return (
    <div className="filter-toolbar-filters" aria-label="Filter kompetisi" aria-busy={isPending}>
      <FilterDropdown
        label="Kategori"
        options={CATEGORY_OPTIONS}
        value={selection.category}
        onChange={onCategory}
        searchable
      />
      <FilterDropdown
        label="Status"
        options={STATUS_OPTIONS}
        value={selection.status}
        onChange={onStatus}
      />
      <FilterDropdown
        label="Lokasi"
        options={LOCATION_OPTIONS}
        value={selection.location}
        onChange={onLocation}
      />
      <FilterPill
        count={setFilterCount}
        className="filter-dropdown-trigger"
        onClick={onOpenPanel}
      />
      {setFilterCount > 0 ? (
        <IconButton
          variant="outline"
          icon="trash"
          label="Hapus semua filter"
          onClick={onClearAll}
        />
      ) : null}
      {isPending ? <Spinner size="sm" /> : null}
      <div className="filter-toolbar-sort">
        <FilterDropdown
          label="Urutkan"
          options={SORT_OPTIONS}
          value={selection.sort}
          onChange={onSort}
          align="end"
        />
      </div>
    </div>
  );
}

type CompetitionPhoneFiltersProps = {
  selection: FilterSelection;
  isPending?: boolean;
  onOpenPanel: () => void;
  onOpenSection: (section: FilterSheetSection) => void;
  onToggleOpenStatus: () => void;
  onToggleOnlineLocation: () => void;
  onToggleFreeFee: () => void;
};

/**
 * The phone filter bar, pinned to the bottom of the screen: the Filter pill stays at its left end
 * and five quick chips scroll sideways beside it. It is hidden from 928 px up, where the row shows.
 */
export function CompetitionPhoneFilters({
  selection,
  isPending = false,
  onOpenPanel,
  onOpenSection,
  onToggleOpenStatus,
  onToggleOnlineLocation,
  onToggleFreeFee,
}: CompetitionPhoneFiltersProps) {
  const isOpenStatusOn = selection.status === OPEN_STATUS;
  const isOnlineLocationOn = selection.location === ONLINE_LOCATION;
  const isFreeFeeOn = selection.fee.kind === "free";

  return (
    <div className="filter-phone glass-chrome" aria-busy={isPending}>
      <FilterPill
        count={listSetFilters(selection).length}
        className="action-chip filter-phone-pill"
        onClick={onOpenPanel}
      />
      <div className="filter-phone-row">
        <button type="button" className="action-chip" onClick={() => onOpenSection("sort")}>
          Urutkan
        </button>
        <button type="button" className="action-chip" onClick={() => onOpenSection("category")}>
          Kategori
        </button>
        <button
          type="button"
          className="action-chip"
          aria-pressed={isOpenStatusOn}
          data-selected={isOpenStatusOn ? "true" : undefined}
          onClick={onToggleOpenStatus}
        >
          Dibuka
        </button>
        <button
          type="button"
          className="action-chip"
          aria-pressed={isOnlineLocationOn}
          data-selected={isOnlineLocationOn ? "true" : undefined}
          onClick={onToggleOnlineLocation}
        >
          Online
        </button>
        <button
          type="button"
          className="action-chip"
          aria-pressed={isFreeFeeOn}
          data-selected={isFreeFeeOn ? "true" : undefined}
          onClick={onToggleFreeFee}
        >
          Gratis
        </button>
        {isPending ? <Spinner size="sm" /> : null}
      </div>
    </div>
  );
}
