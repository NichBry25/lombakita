import type { ReactNode } from "react";
import { Icon } from "@/components/ui";

type AuthPageFrameProps = {
  children: ReactNode;
  title: string;
  description: string;
  eyebrow?: string;
};

export function AuthPageFrame({
  children,
  title,
  description,
  eyebrow = "Lombakita ID",
}: AuthPageFrameProps) {
  return (
    <main className="auth-page">
      <section className="brand-band auth-context-panel">
        <div className="stack-md">
          <span className="auth-context-mark" aria-hidden="true">
            <Icon name="trophy" size="lg" />
          </span>
          <div className="stack-sm">
            <p className="eyebrow">{eyebrow}</p>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
        </div>
        <div className="auth-context-note">
          <Icon name="check" size="sm" />
          <span>Identitas akun dan peran diverifikasi sebelum akses diberikan.</span>
        </div>
      </section>
      <section className="auth-card">{children}</section>
    </main>
  );
}
