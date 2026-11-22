"use client";

import { useEffect, useRef, useState } from "react";

export const PHONE_SHEET_TOGGLE_ID = "mobile-navigation-toggle";
const ABOVE_PHONE_QUERY = "(min-width: 761px)";
const FIRST_ROW_SELECTOR = "a, button";

// The phone sheet's open state and its behaviour: page scroll locked while it is open, focus on the
// first row when it opens and back on the toggle when it closes, and a close on Escape, on a route
// change and when the viewport grows past the phone width.
export function usePhoneSheet(pathname: string) {
  const [state, setState] = useState({ open: false, pathname });
  const sheetRef = useRef<HTMLElement>(null);

  // A route change that did not come from the sheet closes it. Adjusting state while rendering
  // keeps a stale open flag from reviving the sheet when the same path is visited again.
  if (state.pathname !== pathname) {
    setState({ open: false, pathname });
  }

  const isOpen = state.open;

  const focusToggle = () => {
    document.getElementById(PHONE_SHEET_TOGGLE_ID)?.focus();
  };

  const closeSheet = ({ returnFocus }: { returnFocus: boolean }) => {
    setState({ open: false, pathname });
    if (returnFocus) focusToggle();
  };

  const toggleSheet = () => {
    if (isOpen) {
      closeSheet({ returnFocus: true });
      return;
    }
    setState({ open: true, pathname });
  };

  useEffect(() => {
    if (!isOpen) return;
    sheetRef.current?.querySelector<HTMLElement>(FIRST_ROW_SELECTOR)?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setState({ open: false, pathname });
      document.getElementById(PHONE_SHEET_TOGGLE_ID)?.focus();
    };
    const aboveDesktopBreakpoint = window.matchMedia(ABOVE_PHONE_QUERY);
    const closeOnGrow = (event: MediaQueryListEvent) => {
      if (event.matches) setState({ open: false, pathname });
    };
    document.addEventListener("keydown", closeOnEscape);
    aboveDesktopBreakpoint.addEventListener("change", closeOnGrow);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      aboveDesktopBreakpoint.removeEventListener("change", closeOnGrow);
    };
  }, [isOpen, pathname]);

  return { isOpen, sheetRef, toggleSheet, closeSheet };
}
