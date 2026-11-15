"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

const TRIGGER_SELECTOR = "[aria-haspopup='menu']";
const ITEM_SELECTOR = "[role='menuitem']";

// WAI-ARIA menu-button behaviour shared by the header's two menus: open and close, roving focus
// between the rows, Escape back to the trigger, Tab out, and a press outside.
export function useHeaderMenu(itemCount: number) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnPressOutside = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnPressOutside);
    return () => document.removeEventListener("pointerdown", closeOnPressOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR);
    items?.[activeIndex]?.focus();
  }, [open, activeIndex]);

  const openMenu = () => {
    setActiveIndex(0);
    setOpen(true);
  };

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    openMenu();
  };

  const closeAndFocusTrigger = () => {
    setOpen(false);
    rootRef.current?.querySelector<HTMLElement>(TRIGGER_SELECTOR)?.focus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
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
        setActiveIndex((index) => Math.min(itemCount - 1, index + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(0, index - 1));
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return {
    open,
    setOpen,
    setActiveIndex,
    rootRef,
    menuRef,
    toggleMenu,
    onTriggerKeyDown,
    onMenuKeyDown,
  };
}
