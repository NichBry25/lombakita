import type { ReactNode } from "react";

// The short status line at the right end of a bottom bar, left of its button. It is not
// pressable. A number inside it goes in a <strong>.
export function BarNote({ children }: { children: ReactNode }) {
  return (
    <p className="bar-note">
      <span className="bar-note-halo" aria-hidden="true">
        <span className="bar-note-dot" />
      </span>
      <span>{children}</span>
    </p>
  );
}
