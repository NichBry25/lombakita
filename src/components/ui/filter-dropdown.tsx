"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icon";

export type FilterOption = { value: string; label: string };

type FilterDropdownProps = {
  label: string;
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
  // A field at the top of the menu narrows the options as the reader types.
  searchable?: boolean;
  // "end" opens the menu with its right edge on the right edge of the trigger.
  align?: "start" | "end";
};

type ShownOption = { option: FilterOption; index: number };

// Case-insensitive match on the label. Shared with menus drawn outside the dropdown (the phone
// filter sheet) so one rule decides what a typed word finds.
export const optionMatchesQuery = (option: FilterOption, query: string): boolean =>
  option.label.toLowerCase().includes(query.trim().toLowerCase());

export function FilterDropdown({
  label,
  options,
  value,
  onChange,
  searchable = false,
  align = "start",
}: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionIdPrefix = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex] ?? options[0];
  const isDefault = selectedIndex === 0; // options[0] is the cleared "Semua …" state
  const triggerLabel = isDefault ? label : `${label}: ${selected?.label}`;
  const accessibleName = isDefault ? label : `${label}: ${selected?.label}`;

  // Each shown option keeps its place in `options`, because the selection is compared there.
  const shownOptions: ShownOption[] = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => !searchable || optionMatchesQuery(option, query));
  const activeOptionId = shownOptions[activeIndex]
    ? `${optionIdPrefix}-${shownOptions[activeIndex].index}`
    : undefined;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Roving focus: move DOM focus to the active option as the user navigates. A searchable menu
  // keeps focus in its field instead, so typing is never interrupted, and points at the active
  // option with aria-activedescendant.
  useEffect(() => {
    if (!open || searchable) return;
    const nodes = listRef.current?.querySelectorAll<HTMLElement>("[role='option']");
    nodes?.[activeIndex]?.focus();
  }, [open, activeIndex, searchable]);

  useEffect(() => {
    if (!open || !searchable) return;
    searchRef.current?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (!open || !searchable) return;
    const nodes = listRef.current?.querySelectorAll<HTMLElement>("[role='option']");
    nodes?.[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, searchable]);

  const openMenu = () => {
    setQuery("");
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  const closeAndFocusTrigger = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const commit = (shownIndex: number) => {
    const shown = shownOptions[shownIndex];
    if (shown) onChange(shown.option.value);
    closeAndFocusTrigger();
  };

  const changeQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    setActiveIndex(0);
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu();
    }
  };

  const lastShownIndex = Math.max(0, shownOptions.length - 1);

  const onListKeyDown = (event: React.KeyboardEvent) => {
    // In the search field Home, End and the space bar belong to the text being typed.
    const keepsTextKeys = searchable;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        closeAndFocusTrigger();
        break;
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(lastShownIndex, index + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        break;
      case "Home":
        if (keepsTextKeys) break;
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        if (keepsTextKeys) break;
        event.preventDefault();
        setActiveIndex(lastShownIndex);
        break;
      case " ":
        if (keepsTextKeys) break;
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Enter":
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const optionItems = shownOptions.map(({ option, index }, shownIndex) => (
    <li
      key={option.value}
      id={searchable ? `${optionIdPrefix}-${index}` : undefined}
      role="option"
      aria-selected={index === selectedIndex}
      tabIndex={-1}
      className="filter-dropdown-option"
      data-selected={index === selectedIndex ? "true" : undefined}
      data-active={searchable && shownIndex === activeIndex ? "true" : undefined}
      onClick={() => commit(shownIndex)}
    >
      <span>{option.label}</span>
      <span className="filter-dropdown-option-check" aria-hidden="true">
        {index === selectedIndex ? <Icon name="check" /> : null}
      </span>
    </li>
  ));

  const menuAlign = align === "end" ? "end" : undefined;

  const plainMenu = (
    <ul
      className="filter-dropdown-menu"
      role="listbox"
      aria-label={label}
      data-align={menuAlign}
      ref={listRef}
      onKeyDown={onListKeyDown}
    >
      {optionItems}
    </ul>
  );

  const listId = `${optionIdPrefix}-list`;

  const searchableMenu = (
    <div
      className="filter-dropdown-menu"
      data-searchable="true"
      data-align={menuAlign}
      onKeyDown={onListKeyDown}
    >
      <input
        ref={searchRef}
        type="text"
        role="combobox"
        className="form-input filter-dropdown-search"
        placeholder={`Cari ${label.toLowerCase()}…`}
        aria-label={`Cari ${label.toLowerCase()}`}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        value={query}
        onChange={(event) => changeQuery(event.target.value)}
      />
      {shownOptions.length > 0 ? (
        <ul
          id={listId}
          className="filter-dropdown-list"
          role="listbox"
          aria-label={label}
          ref={listRef}
        >
          {optionItems}
        </ul>
      ) : (
        <p className="filter-dropdown-empty" role="status">
          {`${label} tidak ditemukan`}
        </p>
      )}
    </div>
  );

  const menu = searchable ? searchableMenu : plainMenu;

  return (
    <div className="filter-dropdown" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className="filter-dropdown-trigger"
        data-active={isDefault ? undefined : "true"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={accessibleName}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="filter-dropdown-trigger-label">{triggerLabel}</span>
        <Icon name="chevron-down" className="filter-dropdown-chevron" />
      </button>
      {open ? menu : null}
    </div>
  );
}
