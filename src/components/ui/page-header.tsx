import type { ReactNode } from "react";
import { joinClassNames } from "./class-names";
import { IconButtonLink } from "./button";

type PageHeaderBaseProps = {
  title: string;
  backHref?: string;
  backLabel?: string;
  actions?: ReactNode;
  className?: string;
};

type PageHeaderProps = PageHeaderBaseProps & { description?: string };

export function PageHeader({
  title,
  description,
  backHref,
  backLabel = "Kembali",
  actions,
  className,
}: PageHeaderProps) {
  const backLinkLabel = backLabel === "Kembali" ? "Kembali" : `Kembali ke ${backLabel}`;

  return (
    <header className={joinClassNames("page-heading", className)}>
      <div className="page-heading-main">
        {backHref ? (
          <IconButtonLink
            href={backHref}
            icon="arrow-left"
            variant="plain"
            size="back"
            label={backLinkLabel}
          />
        ) : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-heading-actions">{actions}</div> : null}
    </header>
  );
}
