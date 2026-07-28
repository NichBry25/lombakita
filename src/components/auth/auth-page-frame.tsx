import type { ReactNode } from "react";
import { Icon } from "@/components/ui";

/**
 * The context panel carries at most two lines of text: the title, plus EITHER a preceding
 * eyebrow OR a following description — never both. Passing both is a type error.
 */
type AuthPageFrameProps = {
  children: ReactNode;
  title: string;
} & ({ eyebrow: string; description?: never } | { description: string; eyebrow?: never });

export function AuthPageFrame({ children, title, description, eyebrow }: AuthPageFrameProps) {
  return (
    <main className="auth-page">
      <section className="brand-band auth-context-panel">
        <div className="stack-md">
          <span className="auth-context-mark" aria-hidden="true">
            <Icon name="trophy" size="lg" />
          </span>
          <div className="stack-sm">
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
        </div>
        <div className="auth-context-note">
          <Icon name="check" size="sm" />
          <span>Email diverifikasi sebelum akun aktif.</span>
        </div>
      </section>
      <section className="auth-card">{children}</section>
    </main>
  );
}
