"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { FormActionBar } from "@/components/ui";

type RegisterStickyBarProps = {
  targetId: string;
  children: ReactNode;
};

export function RegisterStickyBar({ targetId, children }: RegisterStickyBarProps) {
  const [targetWhollyOnScreen, setTargetWhollyOnScreen] = useState(true);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    // Threshold 1: a register control cut off by the screen edge counts as off screen.
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setTargetWhollyOnScreen(entry.intersectionRatio === 1);
      },
      { threshold: 1 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [targetId]);

  return (
    <FormActionBar
      variant="register"
      className="register-sticky-bar"
      isVisible={!targetWhollyOnScreen}
    >
      {children}
    </FormActionBar>
  );
}
