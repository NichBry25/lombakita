"use client";

import { FilterDropdown, Spinner, type FilterOption } from "@/components/ui";
import { COMPETITION_CATEGORY_OPTIONS } from "@/lib/competitions/categories";
import { COMPETITION_MODE_OPTIONS } from "@/lib/competitions/modes";

const CATEGORY_OPTIONS: FilterOption[] = [
  { value: "", label: "Semua kategori" },
  ...COMPETITION_CATEGORY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
];

const MODE_OPTIONS: FilterOption[] = [
  { value: "", label: "Semua mode" },
  ...COMPETITION_MODE_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
];

// The default ("") hides competitions whose registration deadline has passed, so it is labelled
// for what it actually shows. "all" is the explicit opt-in that also surfaces finished
// competitions — their pages stay published, so they remain findable rather than disappearing.
const STATUS_OPTIONS: FilterOption[] = [
  { value: "", label: "Masih berjalan" },
  { value: "upcoming", label: "Akan datang" },
  { value: "open", label: "Dibuka" },
  { value: "closing", label: "Segera ditutup" },
  { value: "closed", label: "Ditutup" },
  { value: "all", label: "Semua termasuk selesai" },
];

const TEAM_SIZE_OPTIONS: FilterOption[] = [
  { value: "", label: "Semua ukuran" },
  { value: "solo", label: "Individu (1)" },
  { value: "small", label: "Tim kecil (2–4)" },
  { value: "large", label: "Tim besar (5+)" },
];

const SORT_OPTIONS: FilterOption[] = [
  { value: "created_desc", label: "Terbaru" },
  { value: "deadline_asc", label: "Deadline terdekat" },
  { value: "deadline_desc", label: "Deadline terjauh" },
];

type CompetitionFiltersProps = {
  category: string;
  mode: string;
  status: string;
  teamSize: string;
  sort: string;
  // A filter change navigates, and this row is the control that owns that navigation, so it
  // carries the busy state and shows the spinner while the next result set is being fetched.
  isPending?: boolean;
  onCategory: (value: string) => void;
  onMode: (value: string) => void;
  onStatus: (value: string) => void;
  onTeamSize: (value: string) => void;
  onSort: (value: string) => void;
};

export function CompetitionFilters({
  category,
  mode,
  status,
  teamSize,
  sort,
  isPending = false,
  onCategory,
  onMode,
  onStatus,
  onTeamSize,
  onSort,
}: CompetitionFiltersProps) {
  return (
    <div className="filter-toolbar-filters" aria-label="Filter kompetisi" aria-busy={isPending}>
      <FilterDropdown
        label="Kategori"
        options={CATEGORY_OPTIONS}
        value={category}
        onChange={onCategory}
      />
      <FilterDropdown label="Mode" options={MODE_OPTIONS} value={mode} onChange={onMode} />
      <FilterDropdown label="Status" options={STATUS_OPTIONS} value={status} onChange={onStatus} />
      <FilterDropdown
        label="Ukuran tim"
        options={TEAM_SIZE_OPTIONS}
        value={teamSize}
        onChange={onTeamSize}
      />
      <FilterDropdown label="Urutkan" options={SORT_OPTIONS} value={sort} onChange={onSort} />
      {isPending ? <Spinner size="sm" /> : null}
    </div>
  );
}
