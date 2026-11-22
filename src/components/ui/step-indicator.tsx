import { IconButton } from "./button";
import { joinClassNames } from "./class-names";

type StepIndicatorProps = {
  currentStep: number;
  totalSteps: number;
  stepName: string;
  // Only a flow that goes back to its previous step without saving passes this. It adds the back
  // arrow at the left of the line.
  onBackToPreviousStep?: () => void;
  className?: string;
};

type SegmentState = "done" | "current" | "todo";

function getSegmentState(step: number, currentStep: number): SegmentState {
  if (step < currentStep) {
    return "done";
  }
  return step === currentStep ? "current" : "todo";
}

/**
 * Where the user stands in a flow spread over several pages or stages: a line naming the step, and
 * a bar with one segment per step. The line carries the meaning, so the bar stays out of the
 * accessibility tree. Segments before the current step are done and later ones are not reached,
 * whichever steps the user has visited.
 */
export function StepIndicator({
  currentStep,
  totalSteps,
  stepName,
  onBackToPreviousStep,
  className,
}: StepIndicatorProps) {
  const steps = Array.from({ length: totalSteps }, (_, index) => index + 1);

  return (
    <div className={joinClassNames("step-indicator", className)}>
      <div className="step-indicator-row">
        {onBackToPreviousStep ? (
          <IconButton
            icon="arrow-left"
            variant="plain"
            size="back"
            label="Kembali ke langkah sebelumnya"
            onClick={onBackToPreviousStep}
          />
        ) : null}
        <p className="step-indicator-text">
          {`Langkah ${currentStep} dari ${totalSteps}: `}
          <strong>{stepName}</strong>
        </p>
      </div>
      <div className="step-indicator-bar" aria-hidden="true">
        {steps.map((step) => (
          <span
            key={step}
            className="step-indicator-segment"
            data-state={getSegmentState(step, currentStep)}
          />
        ))}
      </div>
    </div>
  );
}
