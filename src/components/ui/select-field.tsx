"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";
import { joinClassNames } from "./class-names";

export type SelectFieldOption = { value: string; label: string };

type SelectFieldProps = {
  // Accessible name for the control (mirrors the visible field label).
  label: string;
  options: SelectFieldOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
};

// Brand-styled form dropdown. Shares the accessible listbox interaction of FilterDropdown
// (trigger + listbox popup, roving focus, full keyboard support) so form selects never fall
// back to native browser chrome. Controlled via value/onChange.
export function SelectField({
  label,
  options,
  value,
  onChange,
  placeholder = "— Pilih —",
  disabled = false,
  id,
  className,
}: SelectFieldProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

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

  useEffect(() => {
    if (!open) return;
    const nodes = listRef.current?.querySelectorAll<HTMLElement>("[role='option']");
    nodes?.[activeIndex]?.focus();
  }, [open, activeIndex]);

  const openMenu = () => {
    if (disabled) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
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
    <div className={joinClassNames("select-field", className)} ref={rootRef}>
      <button
        type="button"
        id={id}
        ref={buttonRef}
        className="select-field-trigger"
        data-placeholder={selected ? undefined : "true"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={selected ? `${label}: ${selected.label}` : label}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="select-field-trigger-label">
          {selected ? selected.label : placeholder}
        </span>
        <Icon name="chevron-down" size="sm" className="select-field-chevron" />
      </button>
      {open ? (
        <ul
          className="select-field-menu"
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
              className="select-field-option"
              data-selected={index === selectedIndex ? "true" : undefined}
              onClick={() => commit(index)}
            >
              <span className="select-field-option-check" aria-hidden="true">
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
