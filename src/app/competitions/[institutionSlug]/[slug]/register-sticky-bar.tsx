"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

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
    <div
      className="glass-chrome register-sticky-bar"
      data-visible={targetWhollyOnScreen ? "false" : "true"}
    >
      {children}
    </div>
  );
}
