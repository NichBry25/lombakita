import type { ReactNode } from "react";
import { Icon } from "@/components/ui";

type AuthPageFrameProps = {
  children: ReactNode;
  title: string;
  description: string;
};

export function AuthPageFrame({ children, title, description }: AuthPageFrameProps) {
  return (
    <main className="auth-page">
      <section className="brand-band auth-context-panel">
        <div className="stack-md">
          <span className="auth-context-mark" aria-hidden="true">
            <Icon name="trophy" size="lg" />
          </span>
          <div className="stack-sm">
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
        </div>
      </section>
      <section className="auth-card">{children}</section>
    </main>
  );
}
