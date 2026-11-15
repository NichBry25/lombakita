"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { IconButton } from "./button";
import type { IconName } from "./icon";

export type MenuButtonItem = {
  key: string;
  label: string;
  onSelect: () => void;
};

type MenuButtonProps = {
  // Names the trigger and the menu. In a repeated row it names the row too.
  label: string;
  icon: IconName;
  items: readonly MenuButtonItem[];
  tooltip?: string;
  disabled?: boolean;
  loading?: boolean;
};

type MenuPlacement = { top: string; right: string };

// WAI-ARIA menu button for a list of actions. The panel is placed with position: fixed from the
// trigger's measured box, so a box with overflow around the trigger (a table's scroll area) cannot
// clip it. It uses the header menu's classes for surface, edge, shadow and items. Because a fixed
// panel does not follow the page, any scroll or resize closes it.
export function MenuButton({
  label,
  icon,
  items,
  tooltip,
  disabled = false,
  loading = false,
}: MenuButtonProps) {
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const isOpen = placement !== null;

  useEffect(() => {
    if (!isOpen) return;
    const closeOnPressOutside = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setPlacement(null);
      }
    };
    const closeOnMove = () => setPlacement(null);
    document.addEventListener("pointerdown", closeOnPressOutside);
    window.addEventListener("scroll", closeOnMove, true);
    window.addEventListener("resize", closeOnMove);
    return () => {
      document.removeEventListener("pointerdown", closeOnPressOutside);
      window.removeEventListener("scroll", closeOnMove, true);
      window.removeEventListener("resize", closeOnMove);
    };
  }, [isOpen]);

  // Roving focus: DOM focus follows the active item as the arrows move it.
  useEffect(() => {
    if (!isOpen) return;
    const menuItems = panelRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']");
    // A scroll closes the menu, so moving focus must never scroll the page.
    menuItems?.[activeIndex]?.focus({ preventScroll: true });
  }, [isOpen, activeIndex]);

  const focusTrigger = () => {
    const trigger = rootRef.current?.firstElementChild;
    if (trigger instanceof HTMLElement) trigger.focus();
  };

  const openMenu = () => {
    const trigger = rootRef.current;
    if (!trigger) return;
    const box = trigger.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    setActiveIndex(0);
    setPlacement({
      top: `calc(${box.bottom}px + var(--space-2))`,
      right: `${viewportWidth - box.right}px`,
    });
  };

  const closeAndFocusTrigger = () => {
    setPlacement(null);
    focusTrigger();
  };

  const selectItem = (item: MenuButtonItem) => {
    closeAndFocusTrigger();
    item.onSelect();
  };

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu();
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        closeAndFocusTrigger();
        break;
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => Math.min(items.length - 1, index + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        break;
      case "Tab":
        closeAndFocusTrigger();
        break;
      default:
        break;
    }
  };

  return (
    <span className="menu-button-root" ref={rootRef}>
      <IconButton
        icon={icon}
        label={label}
        tooltip={tooltip}
        variant="outline"
        disabled={disabled}
        loading={loading}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        onClick={() => (isOpen ? setPlacement(null) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      />
      {isOpen ? (
        <div
          id={panelId}
          className="header-dashboard-panel glass-focus menu-button-panel"
          role="menu"
          aria-label={label}
          ref={panelRef}
          style={placement}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="header-dashboard-menuitem"
              onClick={() => selectItem(item)}
              onFocus={() => setActiveIndex(index)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
