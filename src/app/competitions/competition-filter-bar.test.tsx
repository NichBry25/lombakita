// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { CompetitionFilterBar } from "./competition-filter-bar";
import type { CompetitionSearchParams } from "./search-params";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ meta: { total: 12 } }) });
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const renderBar = (params: CompetitionSearchParams = {}, total = 40) =>
  render(
    <UIPrimitivesProvider>
      <CompetitionFilterBar params={params} total={total} />
    </UIPrimitivesProvider>,
  );

const pillRow = () => within(document.querySelector<HTMLElement>(".filter-toolbar-filters")!);
const phoneRow = () => within(document.querySelector<HTMLElement>(".filter-phone")!);
const sheet = () => within(screen.getByRole("dialog", { name: "Filter" }));

const pressKey = (element: HTMLElement, key: string, times = 1) => {
  for (let count = 0; count < times; count++) fireEvent.keyDown(element, { key });
};

const openSheet = () => {
  fireEvent.click(phoneRow().getByRole("button", { name: /^Filter/ }));
};

const sheetButton = () => sheet().getByRole("button", { name: /^Tampilkan/ });

describe("the desktop pill row", () => {
  it("shows Kategori, Ukuran tim, Status and Urutkan, and no Mode", () => {
    renderBar();

    const labels = pillRow()
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));

    expect(labels).toEqual(["Kategori", "Ukuran tim", "Status", "Urutkan"]);
  });

  it("changes the address only when Terapkan is pressed, not while the handles move", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Ukuran tim" }));
    const menu = screen.getByRole("dialog", { name: "Ukuran tim" });

    pressKey(within(menu).getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    pressKey(within(menu).getByRole("slider", { name: "Ukuran tim maksimum" }), "ArrowLeft", 6);
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.click(within(menu).getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/competitions?teamMin=2&teamMax=4");
  });

  it("shows only individual competitions with both handles on 1", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Ukuran tim" }));
    const menu = screen.getByRole("dialog", { name: "Ukuran tim" });

    pressKey(within(menu).getByRole("slider", { name: "Ukuran tim maksimum" }), "Home");
    expect(within(menu).getByText("Individu")).toBeTruthy();
    fireEvent.click(within(menu).getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions?teamMax=1");
  });

  it("drops an old teamSize word when a range is applied, and keeps the search term", () => {
    renderBar({ q: "lomba", teamSize: "small", sort: "deadline_asc" });
    fireEvent.click(pillRow().getByRole("button", { name: "Ukuran tim" }));
    const menu = screen.getByRole("dialog", { name: "Ukuran tim" });

    pressKey(within(menu).getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight", 4);
    fireEvent.click(within(menu).getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions?q=lomba&sort=deadline_asc&teamMin=5");
  });

  it("shows the applied range in the pill and opens the menu on it", () => {
    renderBar({ teamMin: "2", teamMax: "4" });

    fireEvent.click(pillRow().getByRole("button", { name: "Ukuran tim: 2 sampai 4" }));
    const menu = screen.getByRole("dialog", { name: "Ukuran tim" });

    expect(
      within(menu)
        .getByRole("slider", { name: "Ukuran tim minimum" })
        .getAttribute("aria-valuenow"),
    ).toBe("2");
    expect(
      within(menu)
        .getByRole("slider", { name: "Ukuran tim maksimum" })
        .getAttribute("aria-valuenow"),
    ).toBe("4");
  });

  it("closes the team size menu on Escape without changing the address", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Ukuran tim" }));
    const menu = screen.getByRole("dialog", { name: "Ukuran tim" });

    pressKey(within(menu).getByRole("slider", { name: "Ukuran tim minimum" }), "Escape");

    expect(screen.queryByRole("dialog", { name: "Ukuran tim" })).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("finds a category by typing and applies it", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Kategori" }));

    fireEvent.change(screen.getByRole("combobox", { name: "Cari kategori" }), {
      target: { value: "deb" },
    });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Debat"]);
    fireEvent.click(screen.getByRole("option", { name: "Debat" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions?category=debate");
  });

  it("opens every menu with its right edge on its pill's right edge", () => {
    renderBar();

    for (const name of ["Kategori", "Status", "Urutkan"]) {
      fireEvent.click(pillRow().getByRole("button", { name }));
      expect(
        screen
          .getByRole(name === "Kategori" ? "combobox" : "listbox", {})
          .closest("[data-align]")
          ?.getAttribute("data-align"),
      ).toBe("end");
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    }

    fireEvent.click(pillRow().getByRole("button", { name: "Ukuran tim" }));
    expect(screen.getByRole("dialog", { name: "Ukuran tim" }).getAttribute("data-align")).toBe(
      "end",
    );
  });
});

describe("the phone chip row", () => {
  it("starts with Filter, then Urutkan, Kategori and Dibuka", () => {
    renderBar();

    const labels = phoneRow()
      .getAllByRole("button")
      .map((button) => button.textContent);

    expect(labels).toEqual(["Filter", "Urutkan", "Kategori", "Dibuka"]);
  });

  it("counts the active filters except sort in Filter (n)", () => {
    renderBar({ category: "debate", status: "open", teamMin: "2", sort: "deadline_asc" });

    expect(phoneRow().getByRole("button", { name: "Filter (3)" })).toBeTruthy();
  });

  it("toggles the status to open with Dibuka", () => {
    const first = renderBar();
    fireEvent.click(phoneRow().getByRole("button", { name: "Dibuka" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?status=open");

    first.unmount();
    renderBar({ status: "open" });
    const pressed = phoneRow().getByRole("button", { name: "Dibuka" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(mockPush).toHaveBeenLastCalledWith("/competitions");
  });

  it("shows one removable chip per active filter, and Hapus semua only when one is active", () => {
    const first = renderBar();
    expect(phoneRow().queryByRole("button", { name: "Hapus semua" })).toBeNull();
    first.unmount();

    renderBar({ category: "debate", status: "open", teamMin: "2", teamMax: "4", q: "x" });
    const applied = within(screen.getByRole("list", { name: "Filter yang dipakai" }));

    expect(applied.getByRole("button", { name: "Hapus filter Debat" })).toBeTruthy();
    expect(
      applied.getByRole("button", { name: "Hapus filter Ukuran tim: 2 sampai 4" }),
    ).toBeTruthy();
    expect(applied.getByRole("button", { name: "Hapus filter Dibuka" })).toBeTruthy();

    fireEvent.click(applied.getByRole("button", { name: "Hapus filter Ukuran tim: 2 sampai 4" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?category=debate&status=open&q=x");

    fireEvent.click(applied.getByRole("button", { name: "Hapus semua" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?q=x");
  });

  it("clears an old mode and teamSize link with Hapus semua", () => {
    renderBar({ mode: "team", teamSize: "small", category: "debate" });

    fireEvent.click(phoneRow().getByRole("button", { name: "Hapus semua" }));

    expect(mockPush).toHaveBeenLastCalledWith("/competitions");
  });
});

describe("the phone filter sheet", () => {
  it("opens full height with a title, a close button, Reset and the four sections", () => {
    renderBar();
    openSheet();

    const dialog = screen.getByRole("dialog", { name: "Filter" });
    expect(dialog.getAttribute("data-height")).toBe("full");
    expect(sheet().getByRole("heading", { name: "Filter" })).toBeTruthy();
    expect(sheet().getByRole("button", { name: "Tutup" })).toBeTruthy();
    expect(sheet().getByRole("button", { name: "Reset" })).toBeTruthy();
    for (const section of ["Kategori", "Ukuran tim", "Status", "Urutkan"]) {
      expect(sheet().getByRole("heading", { name: section })).toBeTruthy();
    }
    expect(sheet().getByRole("textbox", { name: "Cari kategori" })).toBeTruthy();
  });

  it("does not change the address until Tampilkan is pressed", () => {
    renderBar();
    openSheet();

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    fireEvent.click(sheet().getByRole("radio", { name: "Dibuka" }));
    fireEvent.click(sheet().getByRole("radio", { name: "Debat" }));
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(
      "/competitions?category=debate&status=open&sort=created_desc&teamMin=2",
    );
    expect(screen.queryByRole("dialog", { name: "Filter" })).toBeNull();
  });

  it("throws the changes away when closed or dismissed", () => {
    renderBar();
    openSheet();
    fireEvent.click(sheet().getByRole("radio", { name: "Dibuka" }));

    fireEvent.click(sheet().getByRole("button", { name: "Tutup" }));
    expect(screen.queryByRole("dialog", { name: "Filter" })).toBeNull();

    openSheet();
    fireEvent.click(sheet().getByRole("radio", { name: "Dibuka" }));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(screen.queryByRole("dialog", { name: "Filter" })).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("starts from the filters already in the address", () => {
    renderBar({ category: "debate", status: "closing", teamMin: "3", teamMax: "6" });
    openSheet();

    expect(sheet().getByRole("radio", { name: "Debat" }).getAttribute("aria-checked")).toBe("true");
    expect(
      sheet().getByRole("radio", { name: "Segera ditutup" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      sheet().getByRole("slider", { name: "Ukuran tim minimum" }).getAttribute("aria-valuenow"),
    ).toBe("3");
    expect(
      sheet().getByRole("slider", { name: "Ukuran tim maksimum" }).getAttribute("aria-valuenow"),
    ).toBe("6");
  });

  it("resets every section to its default with Reset, and still waits for Tampilkan", () => {
    renderBar({ category: "debate", status: "open", teamMin: "3", sort: "deadline_asc" });
    openSheet();

    fireEvent.click(sheet().getByRole("button", { name: "Reset" }));
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith("/competitions?sort=created_desc");
  });

  it("finds a category by typing in the sheet", () => {
    renderBar();
    openSheet();

    fireEvent.change(sheet().getByRole("textbox", { name: "Cari kategori" }), {
      target: { value: "deb" },
    });
    expect(
      sheet()
        .getAllByRole("radio")
        .filter((radio) => radio.closest("[aria-label='Kategori']"))
        .map((radio) => radio.textContent),
    ).toEqual(["Debat"]);

    fireEvent.change(sheet().getByRole("textbox", { name: "Cari kategori" }), {
      target: { value: "zzz" },
    });
    expect(sheet().getByText("Kategori tidak ditemukan")).toBeTruthy();
  });

  it("opens on the Urutkan or Kategori section with focus in it", () => {
    const first = renderBar();
    fireEvent.click(phoneRow().getByRole("button", { name: "Kategori" }));
    expect(document.activeElement).toBe(sheet().getByRole("textbox", { name: "Cari kategori" }));
    fireEvent.click(sheet().getByRole("button", { name: "Tutup" }));
    first.unmount();

    renderBar({ sort: "deadline_asc" });
    fireEvent.click(phoneRow().getByRole("button", { name: "Urutkan" }));
    expect(document.activeElement).toBe(sheet().getByRole("radio", { name: "Deadline terdekat" }));
  });
});

describe("the live count on the sheet's button", () => {
  // Moves the clock and lets the promises the timer started finish, so the count has landed.
  const settle = async (milliseconds: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    });
  };

  const useTimers = () => vi.useFakeTimers({ shouldAdvanceTime: false });

  it("starts from the page's total and does not ask the server for it", async () => {
    useTimers();
    renderBar({}, 40);
    openSheet();
    await settle(1000);

    expect(sheetButton().textContent).toBe("Tampilkan 40 lomba");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reads total from the list route with the pending filters and a limit of 1", async () => {
    useTimers();
    renderBar({ q: "lomba" }, 40);
    openSheet();

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const requested = new URL(String(mockFetch.mock.calls[0]![0]), "http://localhost");
    expect(requested.pathname).toBe("/api/v1/competitions");
    expect(requested.searchParams.get("teamMin")).toBe("2");
    expect(requested.searchParams.get("q")).toBe("lomba");
    expect(requested.searchParams.get("limit")).toBe("1");
    expect(requested.searchParams.has("page")).toBe(false);
    expect(sheetButton().textContent).toBe("Tampilkan 12 lomba");
  });

  it("asks at most once per 300 ms of changes", async () => {
    useTimers();
    renderBar({}, 40);
    openSheet();

    const minHandle = sheet().getByRole("slider", { name: "Ukuran tim minimum" });
    pressKey(minHandle, "ArrowRight");
    await settle(299);
    expect(mockFetch).not.toHaveBeenCalled();
    pressKey(minHandle, "ArrowRight");
    await settle(299);
    expect(mockFetch).not.toHaveBeenCalled();
    await settle(1);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(
      new URL(String(mockFetch.mock.calls[0]![0]), "http://localhost").searchParams.get("teamMin"),
    ).toBe("3");
  });

  it("keeps the last count and shows its spinner while the request is out", async () => {
    useTimers();
    mockFetch.mockReturnValue(new Promise(() => undefined));
    renderBar({}, 40);
    openSheet();

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);

    expect(sheetButton().textContent).toBe("Tampilkan 40 lomba");
    expect(sheetButton().getAttribute("aria-busy")).toBe("true");
  });

  it("can still apply while the count is loading", async () => {
    useTimers();
    mockFetch.mockReturnValue(new Promise(() => undefined));
    renderBar({}, 40);
    openSheet();

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith("/competitions?sort=created_desc&teamMin=2");
  });

  it("says Tampilkan hasil when the request fails", async () => {
    useTimers();
    mockFetch.mockRejectedValue(new Error("offline"));
    renderBar({}, 40);
    openSheet();

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);

    expect(sheetButton().textContent).toBe("Tampilkan hasil");
    expect(sheetButton().hasAttribute("aria-busy")).toBe(false);
  });

  it("says Tampilkan hasil when the route answers with an error status", async () => {
    useTimers();
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    renderBar({}, 40);
    openSheet();

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);

    expect(sheetButton().textContent).toBe("Tampilkan hasil");
  });
});
