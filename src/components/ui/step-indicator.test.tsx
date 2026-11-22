import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StepIndicator } from "./step-indicator";

const segmentStates = (container: HTMLElement) =>
  [...container.querySelectorAll(".step-indicator-segment")].map((segment) =>
    segment.getAttribute("data-state"),
  );

describe("StepIndicator", () => {
  it("builds the line from the step number, the total and the step name", () => {
    const { container } = render(
      <StepIndicator currentStep={3} totalSteps={5} stepName="Jadwal" />,
    );

    expect(container.querySelector(".step-indicator-text")?.textContent).toBe(
      "Langkah 3 dari 5: Jadwal",
    );
    expect(screen.getByText("Jadwal").tagName).toBe("STRONG");
  });

  it("marks the steps before the current one done and the steps after it not reached", () => {
    const { container } = render(
      <StepIndicator currentStep={3} totalSteps={5} stepName="Jadwal" />,
    );

    expect(segmentStates(container)).toEqual(["done", "done", "current", "todo", "todo"]);
  });

  it("keeps the bar out of the accessibility tree", () => {
    const { container } = render(
      <StepIndicator currentStep={1} totalSteps={2} stepName="Hubungkan aplikasi" />,
    );

    expect(container.querySelector(".step-indicator-bar")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("has no back arrow unless the flow passes one", () => {
    render(<StepIndicator currentStep={2} totalSteps={3} stepName="Peran" />);

    expect(screen.queryByRole("button", { name: "Kembali ke langkah sebelumnya" })).toBeNull();
  });

  it("calls the back handler from the arrow that names the previous step", () => {
    const onBackToPreviousStep = vi.fn();
    render(
      <StepIndicator
        currentStep={3}
        totalSteps={5}
        stepName="Jadwal"
        onBackToPreviousStep={onBackToPreviousStep}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Kembali ke langkah sebelumnya" }));

    expect(onBackToPreviousStep).toHaveBeenCalledTimes(1);
  });
});
