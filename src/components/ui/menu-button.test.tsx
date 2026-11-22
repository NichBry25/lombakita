import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MenuButton, type MenuButtonItem } from "./menu-button";

const buildItems = (onSelect: (key: string) => void): MenuButtonItem[] => [
  { key: "owner", label: "Jadikan pemilik", onSelect: () => onSelect("owner") },
  { key: "member", label: "Jadikan anggota", onSelect: () => onSelect("member") },
];

const renderMenu = (onSelect: (key: string) => void = vi.fn()) =>
  render(<MenuButton label="Ubah peran Dina" icon="edit" items={buildItems(onSelect)} />);

const getTrigger = () => screen.getByRole("button", { name: "Ubah peran Dina" });

describe("MenuButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a menu with the two items and reports it on the trigger", () => {
    renderMenu();
    const trigger = getTrigger();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Ubah peran Dina" });
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Jadikan pemilik",
      "Jadikan anggota",
    ]);
  });

  it("places the panel with position fixed, right edges aligned and 8 px below the trigger", () => {
    renderMenu();
    const trigger = getTrigger();
    const root = trigger.parentElement as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 144,
      left: 700,
      right: 744,
      width: 44,
      height: 44,
      x: 700,
      y: 100,
      toJSON: () => ({}),
    });
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 1000,
    });

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("menu-button-panel");
    expect(menu.style.right).toBe("256px");
    expect(menu.style.top).toContain("144px");
    expect(menu.style.top).toContain("var(--space-2)");
  });

  it("starts on the first item and moves with ArrowDown and ArrowUp", () => {
    renderMenu();
    fireEvent.click(getTrigger());
    const [first, second] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });

  it("opens from the trigger with ArrowDown", () => {
    renderMenu();
    fireEvent.keyDown(getTrigger(), { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    renderMenu();
    const trigger = getTrigger();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Tab and leaves focus on the trigger", () => {
    renderMenu();
    const trigger = getTrigger();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when a press lands outside it and keeps the menu open for a press inside", () => {
    renderMenu();
    fireEvent.click(getTrigger());

    fireEvent.pointerDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a scroll anywhere on the page", () => {
    renderMenu();
    fireEvent.click(getTrigger());

    fireEvent.scroll(window);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("runs the chosen item once, closes, and returns focus to the trigger", () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);
    const trigger = getTrigger();
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole("menuitem", { name: "Jadikan anggota" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("member");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not open while it is disabled", () => {
    render(<MenuButton label="Ubah peran Dina" icon="edit" items={buildItems(vi.fn())} disabled />);

    fireEvent.click(getTrigger());

    expect(screen.queryByRole("menu")).toBeNull();
  });
});
