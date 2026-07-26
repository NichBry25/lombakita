import type { ReactNode } from "react";
import { joinClassNames } from "./class-names";
import { ButtonLink } from "./button";
import { Icon } from "./icon";

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
          <ButtonLink
            href={backHref}
            variant="ghost"
            size="sm"
            leadingIcon={<Icon name="arrow-left" size="sm" />}
            className="page-heading-back"
            title={backLabel}
          >
            {backLabel}
          </ButtonLink>
        ) : null}
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-heading-actions">{actions}</div> : null}
    </header>
  );
}
