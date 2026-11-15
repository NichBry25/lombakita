// @vitest-environment jsdom

import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormTextareaWithLimit } from "./form-controls";

const MAX = 100;

function LimitedField() {
  const [value, setValue] = useState("");
  return (
    <FormTextareaWithLimit
      aria-label="Alasan"
      value={value}
      maxLength={MAX}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

const typeLength = (length: number) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Alasan" }), {
    target: { value: "a".repeat(length) },
  });

const announcement = (container: HTMLElement) =>
  container.querySelector('[aria-live="polite"]')?.textContent;

describe("FormTextareaWithLimit counter", () => {
  it("shows the length against the limit and describes the field by the counter", () => {
    render(<LimitedField />);
    typeLength(12);

    const counter = screen.getByText("12 / 100");
    const field = screen.getByRole("textbox", { name: "Alasan" });
    expect(field.getAttribute("aria-describedby")).toContain(counter.id);
  });

  it("announces nothing below 80 percent of the limit", () => {
    const { container } = render(<LimitedField />);

    typeLength(1);
    expect(announcement(container)).toBe("");
    typeLength(79);
    expect(announcement(container)).toBe("");
  });

  it("announces once at 80 percent and keeps the same words until 90 percent", () => {
    const { container } = render(<LimitedField />);

    typeLength(80);
    expect(announcement(container)).toBe("Sisa 20 karakter");
    typeLength(89);
    expect(announcement(container)).toBe("Sisa 20 karakter");
  });

  it("announces again at 90 percent and keeps the same words until the limit", () => {
    const { container } = render(<LimitedField />);

    typeLength(90);
    expect(announcement(container)).toBe("Sisa 10 karakter");
    typeLength(99);
    expect(announcement(container)).toBe("Sisa 10 karakter");
  });

  it("announces and shows the limit message at the limit and not before", () => {
    const { container } = render(<LimitedField />);

    typeLength(99);
    expect(screen.queryByText("Batas 100 karakter tercapai.")).toBeNull();
    expect(screen.getByText("99 / 100").getAttribute("data-at-limit")).toBeNull();

    typeLength(100);
    expect(announcement(container)).toBe("Batas 100 karakter tercapai.");
    expect(container.querySelector(".form-limit-message")?.textContent).toBe(
      "Batas 100 karakter tercapai.",
    );
    expect(screen.getByText("100 / 100").getAttribute("data-at-limit")).toBe("true");
  });
});
