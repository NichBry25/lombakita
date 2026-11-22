"use client";

import { useEffect, type RefObject } from "react";

const TOAST_LIFT_PROPERTY = "--toast-bar-lift";

// Keeps the toast region above a bottom bar while the bar is on screen. The lift is read from the
// bar's real top edge, so it follows the bar wherever its styles put it, and the region returns to
// its own placement when the bar leaves the screen or unmounts.
export function useToastLiftAbove(barRef: RefObject<HTMLElement | null>, isActive: boolean) {
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !isActive) return;

    const root = document.documentElement;
    const resetLift = () => root.style.removeProperty(TOAST_LIFT_PROPERTY);

    const updateLift = () => {
      const { top, bottom } = bar.getBoundingClientRect();
      const isOnScreen = bottom > 0 && top < window.innerHeight;
      if (!isOnScreen) {
        resetLift();
        return;
      }
      const spaceBelowBar = window.innerHeight - top;
      root.style.setProperty(
        TOAST_LIFT_PROPERTY,
        `calc(${spaceBelowBar}px + var(--bar-toast-gap))`,
      );
    };

    updateLift();
    window.addEventListener("scroll", updateLift, { passive: true });
    window.addEventListener("resize", updateLift);
    // A bar that fades in moves while it does, so its top edge is read again when that ends.
    bar.addEventListener("transitionend", updateLift);
    const sizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateLift);
    sizeObserver?.observe(bar);

    return () => {
      window.removeEventListener("scroll", updateLift);
      window.removeEventListener("resize", updateLift);
      bar.removeEventListener("transitionend", updateLift);
      sizeObserver?.disconnect();
      resetLift();
    };
  }, [barRef, isActive]);
}
