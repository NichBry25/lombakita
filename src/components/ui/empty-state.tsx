import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";

type EmptyStateProps = {
  title: string;
  description: string;
  icon?: IconName;
  action?: ReactNode;
};

export function EmptyState({ title, description, icon = "search", action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        <Icon name={icon} size="xl" />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
