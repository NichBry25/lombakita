"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Button,
  FilterDropdown,
  Icon,
  RangeSlider,
  Spinner,
  type FilterOption,
} from "@/components/ui";
import { COMPETITION_CATEGORY_OPTIONS } from "@/lib/competitions/categories";
import type { FilterSheetSection } from "./competition-filter-sheet";
import {
  TEAM_SIZE_HIGHEST,
  TEAM_SIZE_LOWEST,
  describeTeamRange,
  describeTeamSizeForSpeech,
  isTeamRangeNarrowed,
  type CompetitionSearchParams,
  type FilterSelection,
  type TeamRange,
} from "./search-params";

export const CATEGORY_OPTIONS: FilterOption[] = [
  { value: "", label: "Semua kategori" },
  ...COMPETITION_CATEGORY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
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

type TeamSizeFilterProps = {
  range: TeamRange;
  onApply: (range: TeamRange) => void;
};

// A pill that opens a menu holding the team size slider. The address changes when "Terapkan" is
// pressed and not on every drag, so a drag never fires a navigation per step.
function TeamSizeFilter({ range, onApply }: TeamSizeFilterProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(range);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const isNarrowed = isTeamRangeNarrowed(range);
  const triggerLabel = isNarrowed ? `Ukuran tim: ${describeTeamRange(range)}` : "Ukuran tim";

  useEffect(() => {
    if (!open) return;
    const closeWhenOutside = (event: Event) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("focusin", closeWhenOutside);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("focusin", closeWhenOutside);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>("[role='slider']")?.focus();
  }, [open]);

  const openMenu = () => {
    setDraft(range);
    setOpen(true);
  };

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const applyDraft = () => {
    onApply(draft);
    closeAndFocusTrigger();
  };

  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeAndFocusTrigger();
  };

  return (
    <div className="filter-dropdown" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="filter-dropdown-trigger"
        data-active={isNarrowed ? "true" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className="filter-dropdown-trigger-label">{triggerLabel}</span>
        <Icon name="chevron-down" className="filter-dropdown-chevron" />
      </button>
      {open ? (
        <div
          className="filter-dropdown-menu"
          data-kind="range"
          data-align="end"
          role="dialog"
          aria-label="Ukuran tim"
          onKeyDown={closeOnEscape}
        >
          <RangeSlider
            floor={TEAM_SIZE_LOWEST}
            ceiling={TEAM_SIZE_HIGHEST}
            value={draft}
            onChange={setDraft}
            minHandleLabel="Ukuran tim minimum"
            maxHandleLabel="Ukuran tim maksimum"
            summary={describeTeamRange(draft)}
            describeValue={describeTeamSizeForSpeech}
          />
          <Button variant="primary" size="md" onClick={applyDraft}>
            Terapkan
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type CompetitionFiltersProps = {
  selection: FilterSelection;
  // A filter change navigates, and this row is the control that owns that navigation, so it
  // carries the busy state and shows the spinner while the next result set is being fetched.
  isPending?: boolean;
  onCategory: (value: string) => void;
  onStatus: (value: string) => void;
  onSort: (value: string) => void;
  onTeamRange: (range: TeamRange) => void;
};

/** The desktop pill row. On a phone it is hidden and the chip row below takes its place. */
export function CompetitionFilters({
  selection,
  isPending = false,
  onCategory,
  onStatus,
  onSort,
  onTeamRange,
}: CompetitionFiltersProps) {
  return (
    <div className="filter-toolbar-filters" aria-label="Filter kompetisi" aria-busy={isPending}>
      <FilterDropdown
        label="Kategori"
        options={CATEGORY_OPTIONS}
        value={selection.category}
        onChange={onCategory}
        searchable
        align="end"
      />
      <TeamSizeFilter range={selection.teamRange} onApply={onTeamRange} />
      <FilterDropdown
        label="Status"
        options={STATUS_OPTIONS}
        value={selection.status}
        onChange={onStatus}
        align="end"
      />
      <FilterDropdown
        label="Urutkan"
        options={SORT_OPTIONS}
        value={selection.sort}
        onChange={onSort}
        align="end"
      />
      {isPending ? <Spinner size="sm" /> : null}
    </div>
  );
}

export type AppliedChip = {
  key: "category" | "team" | "status";
  label: string;
  // What removing the chip clears from the address.
  clears: Partial<CompetitionSearchParams>;
};

const labelOfOption = (options: FilterOption[], value: string): string =>
  options.find((option) => option.value === value)?.label ?? value;

/** One chip per active filter. Sort is a way of ordering and not a filter, so it has none. */
export const listAppliedChips = (selection: FilterSelection): AppliedChip[] => {
  const chips: AppliedChip[] = [];
  if (selection.category !== "") {
    chips.push({
      key: "category",
      label: labelOfOption(CATEGORY_OPTIONS, selection.category),
      clears: { category: undefined },
    });
  }
  if (isTeamRangeNarrowed(selection.teamRange)) {
    chips.push({
      key: "team",
      label: `Ukuran tim: ${describeTeamRange(selection.teamRange)}`,
      clears: { teamMin: undefined, teamMax: undefined, teamSize: undefined },
    });
  }
  if (selection.status !== "") {
    chips.push({
      key: "status",
      label: labelOfOption(STATUS_OPTIONS, selection.status),
      clears: { status: undefined },
    });
  }
  return chips;
};

type CompetitionPhoneFiltersProps = {
  selection: FilterSelection;
  isPending?: boolean;
  onOpenSheet: (section?: FilterSheetSection) => void;
  onToggleOpenStatus: () => void;
  onClearChip: (clears: Partial<CompetitionSearchParams>) => void;
  onClearAll: () => void;
};

/**
 * The phone filter row: "Filter (n)" and three quick chips on one sideways row, the last one cut
 * by the screen edge, and under it one removable chip per active filter. It is hidden above 640 px.
 */
export function CompetitionPhoneFilters({
  selection,
  isPending = false,
  onOpenSheet,
  onToggleOpenStatus,
  onClearChip,
  onClearAll,
}: CompetitionPhoneFiltersProps) {
  const appliedChips = listAppliedChips(selection);
  const filterLabel = appliedChips.length > 0 ? `Filter (${appliedChips.length})` : "Filter";
  const isOpenStatusOn = selection.status === OPEN_STATUS;

  return (
    <div className="filter-phone" aria-busy={isPending}>
      <div className="filter-phone-row">
        <button
          type="button"
          className="action-chip"
          aria-haspopup="dialog"
          onClick={() => onOpenSheet()}
        >
          {filterLabel}
        </button>
        <button type="button" className="action-chip" onClick={() => onOpenSheet("sort")}>
          Urutkan
        </button>
        <button type="button" className="action-chip" onClick={() => onOpenSheet("category")}>
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
        {isPending ? <Spinner size="sm" /> : null}
      </div>
      {appliedChips.length > 0 ? (
        <ul className="filter-phone-applied" aria-label="Filter yang dipakai">
          {appliedChips.map((chip) => (
            <li key={chip.key}>
              <button
                type="button"
                className="action-chip"
                data-selected="true"
                aria-label={`Hapus filter ${chip.label}`}
                onClick={() => onClearChip(chip.clears)}
              >
                {chip.label}
                <Icon name="close" />
              </button>
            </li>
          ))}
          <li>
            <Button variant="link" size="sm" onClick={onClearAll}>
              Hapus semua
            </Button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
