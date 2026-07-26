import type { HTMLAttributes } from "react";
import { joinClassNames } from "./class-names";

export type SpinnerSize = "sm" | "md" | "lg";

type SpinnerProps = HTMLAttributes<HTMLSpanElement> & {
  size?: SpinnerSize;
};

/**
 * Rotating arc used as the in-element pending signal.
 *
 * Decorative by construction: the machine-readable pending signal is `aria-busy` on the
 * control that owns the action, so the spinner itself is hidden from assistive technology
 * to avoid announcing a second, meaningless element.
 */
export function Spinner({ size = "md", className, ...spinnerProps }: SpinnerProps) {
  return (
    <span
      {...spinnerProps}
      className={joinClassNames("spinner", className)}
      data-size={size}
      aria-hidden="true"
    />
  );
}
