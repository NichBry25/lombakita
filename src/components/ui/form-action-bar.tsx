"use client";

import { useRef, type ReactNode } from "react";
import { joinClassNames } from "./class-names";
import { useToastLiftAbove } from "./use-toast-lift-above";

type FormActionBarProps = {
  children: ReactNode;
  className?: string;
  // "register" is the narrower bar that is fixed to the screen and holds one button.
  variant?: "form" | "register";
  // Only the register bar hides and shows itself, so the others stay at their default.
  isVisible?: boolean;
};

// The one bottom bar of the app: a floating glass panel with one control at the left and at most
// one Utama at the right. A page-level bar is the LAST element on its page and floats at the
// bottom of the screen until it settles at the true page bottom. Independent sub-forms keep their
// own (non-sticky) save at the end of each sub-form.
export function FormActionBar({
  children,
  className,
  variant = "form",
  isVisible = true,
}: FormActionBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  useToastLiftAbove(barRef, isVisible);

  return (
    <div
      ref={barRef}
      className={joinClassNames("form-action-bar", className)}
      data-variant={variant}
      data-visible={isVisible ? "true" : "false"}
    >
      <div className="form-action-bar-panel glass-focus">{children}</div>
    </div>
  );
}
