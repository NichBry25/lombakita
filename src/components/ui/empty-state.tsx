import { Button, ButtonLink } from "./button";
import { Icon, type IconName } from "./icon";

export type EmptyStateKind = "nothing-yet" | "no-match" | "queue-clear" | "not-found";

// standard sits directly under a page header or a filter. compact sits under a Bagian heading and
// has no icon.
export type EmptyStateSize = "standard" | "compact";

type EmptyStateAction = { label: string } & ({ href: string } | { onSelect: () => void });

type EmptyStateProps = {
  kind: EmptyStateKind;
  title: string;
  description: string;
  size?: EmptyStateSize;
  action?: EmptyStateAction;
  // A page that is nothing but this state has no page header, so the state's title is its h1.
  titleIsPageHeading?: boolean;
};

const ICON_BY_KIND: Record<EmptyStateKind, IconName> = {
  "nothing-yet": "sprout",
  "no-match": "search-x",
  "queue-clear": "check-circle",
  "not-found": "compass",
};

function EmptyStateActionButton({
  action,
  kind,
  size,
}: {
  action: EmptyStateAction;
  kind: EmptyStateKind;
  size: EmptyStateSize;
}) {
  const variant = size === "compact" ? "link" : kind === "no-match" ? "outline" : "primary";

  if ("href" in action) {
    return (
      <ButtonLink href={action.href} variant={variant}>
        {action.label}
      </ButtonLink>
    );
  }

  return (
    <Button variant={variant} onClick={action.onSelect}>
      {action.label}
    </Button>
  );
}

/**
 * An empty state is text on the page: no frame, no fill and no shadow. The kind decides the icon,
 * its tint and which button the action takes. It carries no live region, because a node that
 * appears together with its text is not announced; the page puts `role="status"` on a node that
 * is already there when the list changes.
 */
export function EmptyState({
  kind,
  title,
  description,
  size = "standard",
  action,
  titleIsPageHeading = false,
}: EmptyStateProps) {
  const TitleElement = titleIsPageHeading ? "h1" : "p";

  return (
    <div className="empty-state" data-kind={kind} data-size={size}>
      {size === "standard" ? (
        <span className="empty-state-icon" aria-hidden="true">
          <Icon name={ICON_BY_KIND[kind]} />
        </span>
      ) : null}
      <TitleElement className="empty-state-title">{title}</TitleElement>
      <p className="empty-state-sentence">{description}</p>
      {action ? <EmptyStateActionButton action={action} kind={kind} size={size} /> : null}
    </div>
  );
}
