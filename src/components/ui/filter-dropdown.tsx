"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";

export type FilterOption = { value: string; label: string };

type FilterDropdownProps = {
  label: string;
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
};

export function FilterDropdown({ label, options, value, onChange }: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex] ?? options[0];
  const isDefault = selectedIndex === 0; // options[0] is the cleared "Semua …" state
  const triggerLabel = isDefault ? label : (selected?.label ?? label);
  const accessibleName = isDefault ? label : `${label}: ${selected?.label}`;

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

  // Roving focus: move DOM focus to the active option as the user navigates.
  useEffect(() => {
    if (!open) return;
    const nodes = listRef.current?.querySelectorAll<HTMLElement>("[role='option']");
    nodes?.[activeIndex]?.focus();
  }, [open, activeIndex]);

  const openMenu = () => {
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  const closeAndFocusTrigger = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const commit = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    closeAndFocusTrigger();
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu();
    }
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        closeAndFocusTrigger();
        break;
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(options.length - 1, index + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
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
        <Icon name="chevron-down" size="sm" className="filter-dropdown-chevron" />
      </button>
      {open ? (
        <ul
          className="filter-dropdown-menu glass-focus"
          role="listbox"
          aria-label={label}
          ref={listRef}
          onKeyDown={onListKeyDown}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={index === selectedIndex}
              tabIndex={-1}
              className="filter-dropdown-option"
              data-selected={index === selectedIndex ? "true" : undefined}
              onClick={() => commit(index)}
            >
              <span className="filter-dropdown-option-check" aria-hidden="true">
                {index === selectedIndex ? <Icon name="check" size="sm" /> : null}
              </span>
              {option.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
