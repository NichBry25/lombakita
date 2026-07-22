import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterDropdown, type FilterOption } from "./filter-dropdown";

const options: FilterOption[] = [
  { value: "", label: "Semua status" },
  { value: "open", label: "Dibuka" },
  { value: "closed", label: "Ditutup" },
];

describe("FilterDropdown", () => {
  it("shows the group label when cleared and opens on click", () => {
    render(<FilterDropdown label="Status" options={options} value="" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Status" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // getByRole throws if absent, so this asserts the listbox is present.
    expect(screen.getByRole("listbox", { name: "Status" })).toBeTruthy();
  });

  it("calls onChange with the chosen value and closes", () => {
    const onChange = vi.fn();
    render(<FilterDropdown label="Status" options={options} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    fireEvent.click(screen.getByRole("option", { name: "Ditutup" }));
    expect(onChange).toHaveBeenCalledWith("closed");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("reflects a non-default selection in the trigger name", () => {
    render(<FilterDropdown label="Status" options={options} value="open" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Status: Dibuka" })).toBeTruthy();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<FilterDropdown label="Status" options={options} value="" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Status" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("marks the selected option with aria-selected", () => {
    render(<FilterDropdown label="Status" options={options} value="closed" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Status: Ditutup" }));
    const listbox = screen.getByRole("listbox");
    const option = within(listbox).getByRole("option", { name: "Ditutup" });
    expect(option.getAttribute("aria-selected")).toBe("true");
  });

  it("selects the active option via keyboard (ArrowDown then Enter)", () => {
    const onChange = vi.fn();
    render(<FilterDropdown label="Status" options={options} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("open");
  });
});
