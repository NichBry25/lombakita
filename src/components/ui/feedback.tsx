import type { HTMLAttributes, ReactNode } from "react";
import { joinClassNames } from "./class-names";
import { Icon, type IconName } from "./icon";

export type FeedbackTone = "success" | "warning" | "error" | "info" | "neutral";

type FeedbackProps = HTMLAttributes<HTMLDivElement> & {
  tone?: FeedbackTone;
  lead?: ReactNode;
};

const FEEDBACK_ICONS: Record<FeedbackTone, IconName | null> = {
  info: "info",
  success: "check-circle",
  neutral: null,
  warning: "alert-triangle",
  error: "alert-circle",
};

export function Feedback({
  tone = "info",
  lead,
  className,
  children,
  ...feedbackProps
}: FeedbackProps) {
  const iconName = FEEDBACK_ICONS[tone];

  return (
    <div
      {...feedbackProps}
      className={joinClassNames("feedback", className)}
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
    >
      {iconName ? <Icon name={iconName} className="feedback-icon" aria-hidden="true" /> : null}
      <div className="feedback-body">
        {lead ? <strong className="feedback-lead">{lead} </strong> : null}
        {children}
      </div>
    </div>
  );
}
