import Link from "next/link";
import type { ReactNode } from "react";
import { joinClassNames } from "./class-names";

type PageHeaderProps = {
  title: string;
  description?: string;
  eyebrow?: string;
  backHref?: string;
  backLabel?: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  description,
  eyebrow,
  backHref,
  backLabel = "Kembali",
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header className={joinClassNames("page-heading", className)}>
      <div className="page-heading-main">
        {backHref ? (
          <Link href={backHref} className="page-heading-back">
            <span aria-hidden="true">←</span>
            {backLabel}
          </Link>
        ) : null}
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-heading-actions">{actions}</div> : null}
    </header>
  );
}
