// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tabs, type TabItem } from "./tabs";

const PATHNAME = "/admin/host-checks";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  usePathname: () => "/admin/host-checks",
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

const TABS: readonly TabItem[] = [
  { id: "pemeriksaan", label: "Pemeriksaan penyelenggara", panel: <p>Isi pemeriksaan</p> },
  { id: "centang", label: "Centang", panel: <p>Isi centang</p> },
  { id: "laporan", label: "Laporan", panel: <p>Isi laporan</p> },
];

const renderTabs = () =>
  render(<Tabs label="Antrean pemeriksaan" queryKey="tab" selectedId="pemeriksaan" tabs={TABS} />);

const tabNamed = (name: string): HTMLElement => screen.getByRole("tab", { name });

const pressOnFocusedTab = (key: string) => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
};

const expectSelectedAndFocused = (name: string, tabId: string) => {
  const tab = tabNamed(name);
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tab);
  expect(navigation.replace).toHaveBeenLastCalledWith(`${PATHNAME}?tab=${tabId}`, {
    scroll: false,
  });
};

beforeEach(() => {
  navigation.replace.mockClear();
  navigation.search = "";
});

describe("the tabs primitive", () => {
  it("renders a tablist whose tabs control their panels", () => {
    renderTabs();

    expect(screen.getByRole("tablist", { name: "Antrean pemeriksaan" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Pemeriksaan penyelenggara",
      "Centang",
      "Laporan",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(panels).toHaveLength(3);
    tabs.forEach((tab, index) => {
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      expect(panel).toBe(panels[index]);
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    });

    expect(screen.getByText("Isi pemeriksaan")).toBeTruthy();
    expect(panels[0]?.hasAttribute("hidden")).toBe(false);
    expect(panels[1]?.hasAttribute("hidden")).toBe(true);
    expect(panels[2]?.hasAttribute("hidden")).toBe(true);
    expect(screen.queryByText("Isi centang")).toBeNull();
    expect(screen.queryByText("Isi laporan")).toBeNull();
  });

  it("moves the selection with the arrow keys and wraps at both ends", () => {
    renderTabs();
    tabNamed("Pemeriksaan penyelenggara").focus();

    pressOnFocusedTab("ArrowRight");
    expectSelectedAndFocused("Centang", "centang");

    pressOnFocusedTab("ArrowLeft");
    expectSelectedAndFocused("Pemeriksaan penyelenggara", "pemeriksaan");

    pressOnFocusedTab("ArrowLeft");
    expectSelectedAndFocused("Laporan", "laporan");

    pressOnFocusedTab("ArrowRight");
    expectSelectedAndFocused("Pemeriksaan penyelenggara", "pemeriksaan");
  });

  it("jumps to the first and the last tab with Home and End", () => {
    renderTabs();
    tabNamed("Pemeriksaan penyelenggara").focus();

    pressOnFocusedTab("End");
    expectSelectedAndFocused("Laporan", "laporan");

    pressOnFocusedTab("Home");
    expectSelectedAndFocused("Pemeriksaan penyelenggara", "pemeriksaan");
  });

  it("selects a tab on click and keeps the other parameters of the address", () => {
    navigation.search = "x=1";
    renderTabs();

    fireEvent.click(tabNamed("Centang"));

    expect(tabNamed("Centang").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Isi centang")).toBeTruthy();
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(navigation.replace).toHaveBeenCalledWith(`${PATHNAME}?x=1&tab=centang`, {
      scroll: false,
    });
  });
});
