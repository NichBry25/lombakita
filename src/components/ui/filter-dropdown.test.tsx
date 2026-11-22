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

describe("FilterDropdown without the searchable and align options", () => {
  it("opens the same plain listbox as before: no field, no alignment mark, focus on the option", () => {
    render(<FilterDropdown label="Status" options={options} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Status" }));

    const listbox = screen.getByRole("listbox", { name: "Status" });
    expect(listbox.tagName).toBe("UL");
    expect(listbox.className).toBe("filter-dropdown-menu");
    expect(listbox.hasAttribute("data-align")).toBe(false);
    expect(listbox.hasAttribute("data-searchable")).toBe(false);
    expect(screen.queryByRole("combobox")).toBeNull();

    const first = within(listbox).getByRole("option", { name: "Semua status" });
    expect(first.hasAttribute("id")).toBe(false);
    expect(first.hasAttribute("data-active")).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  it("moves focus through every option with the arrow keys, Home and End", () => {
    render(<FilterDropdown label="Status" options={options} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    const listbox = screen.getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "End" });
    expect(document.activeElement).toBe(within(listbox).getByRole("option", { name: "Ditutup" }));
    fireEvent.keyDown(listbox, { key: "Home" });
    expect(document.activeElement).toBe(
      within(listbox).getByRole("option", { name: "Semua status" }),
    );
  });
});

describe("FilterDropdown align", () => {
  it("marks the menu to open with its right edge on the trigger's right edge", () => {
    render(
      <FilterDropdown label="Status" options={options} value="" onChange={vi.fn()} align="end" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Status" }));

    expect(screen.getByRole("listbox").getAttribute("data-align")).toBe("end");
  });

  it("does not mark a menu that keeps the default alignment", () => {
    render(
      <FilterDropdown label="Status" options={options} value="" onChange={vi.fn()} align="start" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Status" }));

    expect(screen.getByRole("listbox").hasAttribute("data-align")).toBe(false);
  });
});

describe("FilterDropdown triggerIcon", () => {
  it("draws an icon-only trigger named and given its tooltip from the label and the chosen option", () => {
    render(
      <FilterDropdown
        label="Status"
        options={options}
        value=""
        onChange={vi.fn()}
        triggerIcon="arrow-up-down"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Status: Semua status" });
    expect(trigger.textContent).toBe("");
    expect(trigger.getAttribute("data-tooltip")).toBe("Status: Semua status");
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger.hasAttribute("data-active")).toBe(false);
  });

  it("follows the chosen option in its name and shows the selected state", () => {
    render(
      <FilterDropdown
        label="Status"
        options={options}
        value="open"
        onChange={vi.fn()}
        triggerIcon="arrow-up-down"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Status: Dibuka" });
    expect(trigger.getAttribute("data-tooltip")).toBe("Status: Dibuka");
    expect(trigger.getAttribute("data-active")).toBe("true");
  });

  it("opens the same listbox, chooses on click and returns focus to the trigger", () => {
    const onChange = vi.fn();
    render(
      <FilterDropdown
        label="Status"
        options={options}
        value=""
        onChange={onChange}
        triggerIcon="arrow-up-down"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Status: Semua status" });

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    fireEvent.click(screen.getByRole("option", { name: "Ditutup" }));

    expect(onChange).toHaveBeenCalledWith("closed");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(
      <FilterDropdown
        label="Status"
        options={options}
        value=""
        onChange={vi.fn()}
        triggerIcon="arrow-up-down"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Status: Semua status" });

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("FilterDropdown searchable", () => {
  const categories: FilterOption[] = [
    { value: "", label: "Semua kategori" },
    { value: "hackathon", label: "Hackathon" },
    { value: "debat", label: "Debat" },
    { value: "desain", label: "Desain" },
  ];

  const openCategories = (onChange = vi.fn()) => {
    render(
      <FilterDropdown
        label="Kategori"
        options={categories}
        value=""
        onChange={onChange}
        searchable
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Kategori" }));
    return { onChange, field: screen.getByRole("combobox", { name: "Cari kategori" }) };
  };

  const shownLabels = () =>
    within(screen.getByRole("listbox", { name: "Kategori" }))
      .getAllByRole("option")
      .map((option) => option.textContent);

  it("puts a field at the top of the menu and focuses it", () => {
    const { field } = openCategories();

    expect(document.activeElement).toBe(field);
    expect(shownLabels()).toEqual(["Semua kategori", "Hackathon", "Debat", "Desain"]);
  });

  it("narrows the options as you type, ignoring case", () => {
    const { field } = openCategories();

    fireEvent.change(field, { target: { value: "deb" } });
    expect(shownLabels()).toEqual(["Debat"]);

    fireEvent.change(field, { target: { value: "DE" } });
    expect(shownLabels()).toEqual(["Debat", "Desain"]);
  });

  it("says so when nothing matches", () => {
    const { field } = openCategories();

    fireEvent.change(field, { target: { value: "zzz" } });

    expect(screen.getByText("Kategori tidak ditemukan")).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("chooses a typed-for option by click", () => {
    const { onChange, field } = openCategories();

    fireEvent.change(field, { target: { value: "deb" } });
    fireEvent.click(screen.getByRole("option", { name: "Debat" }));

    expect(onChange).toHaveBeenCalledWith("debat");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("moves through the shown options with the arrow keys and chooses with Enter", () => {
    const { onChange, field } = openCategories();

    fireEvent.change(field, { target: { value: "de" } });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: "Desain" }).id,
    );
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("desain");
  });

  it("keeps Home, End and the space bar for the typed text", () => {
    const { onChange, field } = openCategories();

    const homePrevented = !fireEvent.keyDown(field, { key: "Home" });
    const spacePrevented = !fireEvent.keyDown(field, { key: " " });

    expect(homePrevented).toBe(false);
    expect(spacePrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const { field } = openCategories();

    fireEvent.keyDown(field, { key: "Escape" });

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Kategori" }));
  });

  it("starts from an empty field each time the menu opens", () => {
    const { field } = openCategories();
    fireEvent.change(field, { target: { value: "deb" } });
    fireEvent.keyDown(field, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Kategori" }));

    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
  });
});
