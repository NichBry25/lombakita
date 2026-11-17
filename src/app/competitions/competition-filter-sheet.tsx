"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Icon,
  IconButton,
  RangeSlider,
  optionMatchesQuery,
  type FilterOption,
} from "@/components/ui";
import { useModal } from "@/components/ui/primitives";
import { audienceFilterLevels } from "@/lib/competitions/audiences";
import { TEAM_SIZE_HIGHEST, TEAM_SIZE_LOWEST } from "@/lib/competitions/team-range";
import type { CompetitionAudience } from "@/server/db/schema";
import {
  AudienceChecklist,
  FeeFilterControls,
  describeNonDefaultSort,
  listSetFilters,
} from "./competition-filters";
import {
  DEFAULT_FILTER_SELECTION,
  competitionsQuery,
  describeTeamRange,
  describeTeamSizeForSpeech,
  selectionToParams,
  type CompetitionSearchParams,
  type FilterSelection,
} from "./search-params";

export type FilterSheetSection =
  | "category"
  | "team"
  | "location"
  | "audience"
  | "fee"
  | "status"
  | "sort";

const COUNT_DEBOUNCE_MS = 300;

type CountOutcome = { query: string; failed: boolean };

// The address the count is read from: the sheet's pending filters on top of the page's own search
// term and untouched parameters, limited to one row because only `meta.total` is read.
const countQueryFor = (baseParams: CompetitionSearchParams, selection: FilterSelection): string => {
  const query = new URLSearchParams(
    competitionsQuery(baseParams, { ...selectionToParams(selection), page: undefined }),
  );
  query.set("limit", "1");
  return query.toString();
};

const readTotalFromApi = async (query: string, signal: AbortSignal): Promise<number> => {
  const response = await fetch(`/api/v1/competitions?${query}`, { signal });
  if (!response.ok) throw new Error(`count request failed with ${response.status}`);
  const body = (await response.json()) as { meta?: { total?: unknown } };
  const total = body.meta?.total;
  if (typeof total !== "number") throw new Error("count response had no total");
  return total;
};

/**
 * How many competitions the sheet's pending filters would show, read from the public listing
 * route at most once per 300 ms of changes. While a request is out the last count stays on
 * screen, and a failed request says so instead of showing a stale number.
 */
function useLiveResultCount(
  baseParams: CompetitionSearchParams,
  selection: FilterSelection,
  initialTotal: number,
  initialSelection: FilterSelection,
) {
  const [lastTotal, setLastTotal] = useState(initialTotal);
  const [outcome, setOutcome] = useState<CountOutcome | null>(null);

  const query = countQueryFor(baseParams, selection);
  const initialQuery = countQueryFor(baseParams, initialSelection);
  const isInitialSelection = query === initialQuery;

  useEffect(() => {
    if (isInitialSelection) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const total = await readTotalFromApi(query, controller.signal);
        setLastTotal(total);
        setOutcome({ query, failed: false });
      } catch {
        if (controller.signal.aborted) return;
        setOutcome({ query, failed: true });
      }
    }, COUNT_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, isInitialSelection]);

  if (isInitialSelection) return { total: initialTotal, isLoading: false, failed: false };
  if (outcome === null || outcome.query !== query) {
    return { total: lastTotal, isLoading: true, failed: false };
  }
  return { total: lastTotal, isLoading: false, failed: outcome.failed };
}

type OptionChoiceListProps = {
  label: string;
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
  // Marks the selected option as where focus lands when the panel opens on this section.
  takesOpeningFocus?: boolean;
};

function OptionChoiceList({
  label,
  options,
  value,
  onChange,
  takesOpeningFocus = false,
}: OptionChoiceListProps) {
  return (
    <div role="radiogroup" aria-label={label} className="filter-sheet-options">
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            className="filter-dropdown-option filter-sheet-option"
            data-selected={isSelected ? "true" : undefined}
            data-modal-focus={takesOpeningFocus && isSelected ? "main" : undefined}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            <span className="filter-dropdown-option-check" aria-hidden="true">
              {isSelected ? <Icon name="check" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

type CategoryChoiceProps = {
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
  takesOpeningFocus: boolean;
};

function CategoryChoice({ options, value, onChange, takesOpeningFocus }: CategoryChoiceProps) {
  const [query, setQuery] = useState("");
  const shownOptions = options.filter((option) => optionMatchesQuery(option, query));

  return (
    <div className="filter-sheet-category">
      <input
        type="text"
        className="form-input"
        placeholder="Cari kategori…"
        aria-label="Cari kategori"
        autoComplete="off"
        data-modal-focus={takesOpeningFocus ? "main" : undefined}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {shownOptions.length > 0 ? (
        <OptionChoiceList
          label="Kategori"
          options={shownOptions}
          value={value}
          onChange={onChange}
        />
      ) : (
        <p className="filter-dropdown-empty" role="status">
          Kategori tidak ditemukan
        </p>
      )}
    </div>
  );
}

type CompetitionFilterSheetProps = {
  initial: FilterSelection;
  // The page's own parameters, so the count keeps the search term the sheet does not edit.
  baseParams: CompetitionSearchParams;
  initialTotal: number;
  categoryOptions: FilterOption[];
  locationOptions: FilterOption[];
  statusOptions: FilterOption[];
  sortOptions: FilterOption[];
  // The one section that is open when the panel opens.
  openAtSection: FilterSheetSection;
  // The section whose opening target takes focus when the panel opens, for a panel opened from the
  // chip of that section. Absent leaves focus where the pop-up puts it.
  focusSection?: FilterSheetSection;
  onApply: (selection: FilterSelection) => void;
};

type CollapsibleSectionProps = {
  id: FilterSheetSection;
  title: string;
  // The section's current filter in words, shown after its name. Absent when nothing is set.
  value: string | undefined;
  isOpen: boolean;
  onToggle: (id: FilterSheetSection) => void;
  children: ReactNode;
};

// A closed section keeps its content in the page, hidden, so what was typed in it survives a
// collapse and the open section is the only one a reader can reach.
function CollapsibleSection({
  id,
  title,
  value,
  isOpen,
  onToggle,
  children,
}: CollapsibleSectionProps) {
  const headerId = `filter-sheet-${id}-header`;
  const panelId = `filter-sheet-${id}-panel`;

  return (
    <section className="filter-sheet-section">
      <h3 className="filter-sheet-heading">
        <button
          id={headerId}
          type="button"
          className="filter-sheet-toggle"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={() => onToggle(id)}
        >
          <span>
            {title}
            {value ? <span className="filter-sheet-value"> · {value}</span> : null}
          </span>
          <Icon name="chevron-down" className="filter-sheet-chevron" />
        </button>
      </h3>
      <div id={panelId} hidden={!isOpen}>
        {children}
      </div>
    </section>
  );
}

/**
 * The filter panel, drawn inside the full-height pop-up: a drawer on desktop and the whole screen
 * on a phone. It edits a copy of the filters, so nothing reaches the address until "Tampilkan",
 * and closing or Esc throws the copy away. One section is open at a time.
 */
export function CompetitionFilterSheet({
  initial,
  baseParams,
  initialTotal,
  categoryOptions,
  locationOptions,
  statusOptions,
  sortOptions,
  openAtSection,
  focusSection,
  onApply,
}: CompetitionFilterSheetProps) {
  const { closeModal } = useModal();
  const [draft, setDraft] = useState(initial);
  const [openSection, setOpenSection] = useState<FilterSheetSection | null>(openAtSection);
  const count = useLiveResultCount(baseParams, draft, initialTotal, initial);
  const setFilters = listSetFilters(draft);

  const toggleAudienceLevel = (level: CompetitionAudience, isTicked: boolean) => {
    const next = isTicked ? [...draft.audience, level] : draft.audience.filter((i) => i !== level);
    setDraft({ ...draft, audience: audienceFilterLevels(next) });
  };

  const clearEveryFilter = () => {
    setDraft((current) => ({ ...DEFAULT_FILTER_SELECTION, sort: current.sort }));
  };

  const toggleSection = (id: FilterSheetSection) => {
    setOpenSection((current) => (current === id ? null : id));
  };

  const valueOfSection = (id: FilterSheetSection): string | undefined =>
    setFilters.find((filter) => filter.section === id)?.value;

  const sectionProps = (id: FilterSheetSection, title: string) => ({
    id,
    title,
    value: id === "sort" ? describeNonDefaultSort(draft.sort) : valueOfSection(id),
    isOpen: openSection === id,
    onToggle: toggleSection,
  });

  const showButtonLabel = count.failed ? "Tampilkan hasil" : `Tampilkan ${count.total} lomba`;

  return (
    <div className="filter-sheet">
      <header className="filter-sheet-header">
        <h2 className="filter-sheet-title">Filter</h2>
        <div className="filter-sheet-header-actions">
          <IconButton
            variant="plain"
            icon="trash"
            label="Hapus semua filter"
            onClick={clearEveryFilter}
          />
          <IconButton variant="plain" icon="close" label="Tutup" onClick={closeModal} />
        </div>
      </header>

      <div className="filter-sheet-body">
        <CollapsibleSection {...sectionProps("category", "Kategori")}>
          <CategoryChoice
            options={categoryOptions}
            value={draft.category}
            onChange={(category) => setDraft({ ...draft, category })}
            takesOpeningFocus={focusSection === "category"}
          />
        </CollapsibleSection>

        <CollapsibleSection {...sectionProps("team", "Ukuran tim")}>
          <RangeSlider
            floor={TEAM_SIZE_LOWEST}
            ceiling={TEAM_SIZE_HIGHEST}
            value={draft.teamRange}
            onChange={(teamRange) => setDraft((current) => ({ ...current, teamRange }))}
            label="Ukuran tim"
            minHandleLabel="Ukuran tim minimum"
            maxHandleLabel="Ukuran tim maksimum"
            summary={describeTeamRange(draft.teamRange)}
            describeValue={describeTeamSizeForSpeech}
          />
        </CollapsibleSection>

        <CollapsibleSection {...sectionProps("location", "Lokasi")}>
          <OptionChoiceList
            label="Lokasi"
            options={locationOptions}
            value={draft.location}
            onChange={(location) => setDraft({ ...draft, location })}
          />
        </CollapsibleSection>

        <CollapsibleSection {...sectionProps("audience", "Untuk")}>
          <AudienceChecklist
            idPrefix="filter-sheet-audience"
            ticked={draft.audience}
            onToggle={toggleAudienceLevel}
          />
        </CollapsibleSection>

        <CollapsibleSection {...sectionProps("fee", "Biaya")}>
          <FeeFilterControls
            value={draft.fee}
            onChange={(fee) => setDraft((current) => ({ ...current, fee }))}
          />
        </CollapsibleSection>

        <CollapsibleSection {...sectionProps("status", "Status")}>
          <OptionChoiceList
            label="Status"
            options={statusOptions}
            value={draft.status}
            onChange={(status) => setDraft({ ...draft, status })}
          />
        </CollapsibleSection>

        <CollapsibleSection {...sectionProps("sort", "Urutkan")}>
          <OptionChoiceList
            label="Urutkan"
            options={sortOptions}
            value={draft.sort}
            onChange={(sort) => setDraft({ ...draft, sort })}
            takesOpeningFocus={focusSection === "sort"}
          />
        </CollapsibleSection>
      </div>

      <footer className="filter-sheet-footer">
        {/* The button stays pressable while the count loads, so a slow or hung request never
            keeps the reader from applying what they chose. */}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={count.isLoading}
          keepFocusWhileLoading
          onClick={() => onApply(draft)}
        >
          {showButtonLabel}
        </Button>
      </footer>
    </div>
  );
}
