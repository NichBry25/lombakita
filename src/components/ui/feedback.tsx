import type { HTMLAttributes } from "react";
import { joinClassNames } from "./class-names";

export type FeedbackTone = "success" | "warning" | "error" | "info" | "neutral";

type FeedbackProps = HTMLAttributes<HTMLDivElement> & {
  tone?: FeedbackTone;
};

export function Feedback({ tone = "info", className, ...feedbackProps }: FeedbackProps) {
  return (
    <div
      {...feedbackProps}
      className={joinClassNames("feedback", className)}
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
    />
  );
}
