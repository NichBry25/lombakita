import { joinClassNames } from "./class-names";

type StepIndicatorProps = {
  current: number;
  total: number;
  label: string;
  className?: string;
};

/**
 * Where the user stands in a flow spread over several pages or stages: a sentence-case line naming
 * the step, and a bar with one segment per step. The line carries the meaning, so the bar stays out
 * of the accessibility tree.
 */
export function StepIndicator({ current, total, label, className }: StepIndicatorProps) {
  const steps = Array.from({ length: total }, (_, index) => index + 1);
  return (
    <div className={joinClassNames("step-indicator", className)}>
      <p className="step-indicator-text">
        Langkah {current} dari {total}: {label}
      </p>
      <div className="step-indicator-bar" aria-hidden="true">
        {steps.map((step) => (
          <span key={step} className="step-indicator-segment" data-reached={step <= current} />
        ))}
      </div>
    </div>
  );
}
