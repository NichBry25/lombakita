"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

type RegisterStickyBarProps = {
  targetId: string;
  children: ReactNode;
};

export function RegisterStickyBar({ targetId, children }: RegisterStickyBarProps) {
  const [targetOffScreen, setTargetOffScreen] = useState(false);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry) setTargetOffScreen(!entry.isIntersecting);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [targetId]);

  return (
    <div
      className="glass-chrome register-sticky-bar"
      data-visible={targetOffScreen ? "true" : "false"}
    >
      {children}
    </div>
  );
}
