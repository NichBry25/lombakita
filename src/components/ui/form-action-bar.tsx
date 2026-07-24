import type { ReactNode } from "react";
import { joinClassNames } from "./class-names";

type FormActionBarProps = {
  children: ReactNode;
  className?: string;
};

// Page-level sticky action bar: the global Save + Back for an edit page. Rendered as the LAST
// element on the page; it floats at the viewport bottom until it settles at the true page
// bottom. Independent sub-forms keep their own (non-sticky) save at the end of each sub-form.
export function FormActionBar({ children, className }: FormActionBarProps) {
  return (
    <div className={joinClassNames("form-action-bar glass-chrome", className)}>{children}</div>
  );
}
