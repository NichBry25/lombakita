import type { ReactNode } from "react";
import { joinClassNames } from "./class-names";
import { ButtonLink, IconButtonLink } from "./button";
import { Icon, type IconName } from "./icon";

// A header holds one action. An icon action sits on the title line. A text action is a link on its
// own line at the end of the header.
type PageHeaderAction =
  | { kind: "icon"; control: ReactNode }
  | { kind: "text"; href: string; label: string; icon: IconName };

type PageHeaderProps = {
  title: string;
  description?: string;
  backHref?: string;
  // The destination page's own title. Without it the arrow is named "Kembali".
  backName?: string;
  // A status pill or a Label. It follows the title's last word and wraps with it.
  titleMark?: ReactNode;
  action?: PageHeaderAction;
  className?: string;
};

function getBackLabel(backName: string | undefined): string {
  return backName ? `Kembali ke ${backName}` : "Kembali";
}

function TitleWithMark({ title, mark }: { title: string; mark: ReactNode }) {
  if (!mark) {
    return title;
  }

  const lastSpaceIndex = title.lastIndexOf(" ");
  const leadingWords = title.slice(0, lastSpaceIndex + 1);
  const lastWord = title.slice(lastSpaceIndex + 1);

  return (
    <>
      {leadingWords}
      <span className="page-heading-last-word">
        {lastWord}
        <span className="page-heading-mark">{mark}</span>
      </span>
    </>
  );
}

export function PageHeader({
  title,
  description,
  backHref,
  backName,
  titleMark,
  action,
  className,
}: PageHeaderProps) {
  return (
    <header className={joinClassNames("page-heading", className)}>
      {backHref ? (
        <IconButtonLink
          href={backHref}
          icon="arrow-left"
          variant="plain"
          size="back"
          label={getBackLabel(backName)}
        />
      ) : null}
      <div className="page-heading-title-row">
        <h1>
          <TitleWithMark title={title} mark={titleMark} />
        </h1>
        {action?.kind === "icon" ? (
          <div className="page-heading-icon-action">{action.control}</div>
        ) : null}
      </div>
      {description ? <p className="page-heading-description">{description}</p> : null}
      {action?.kind === "text" ? (
        <div className="page-heading-text-action">
          <ButtonLink
            href={action.href}
            variant="link"
            leadingIcon={<Icon name={action.icon} size="sm" />}
          >
            {action.label}
          </ButtonLink>
        </div>
      ) : null}
    </header>
  );
}
