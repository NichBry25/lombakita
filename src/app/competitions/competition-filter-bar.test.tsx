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

// formatRupiah separates "Rp" from the digits with a no-break space.
const rupiah = (digits: string): string => `Rp ${digits}`;

// The text the fee slider shows for its range, read from the node because getByText folds the
// no-break space of formatRupiah into a plain one.
const sliderSummaryIn = (dialogName: string): string | null | undefined =>
  screen
    .getByRole("dialog", { name: dialogName })
    .querySelector("[aria-label='Rentang biaya'] .range-slider-summary")?.textContent;

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
  it("shows Kategori, Ukuran tim, Lokasi, Untuk, Biaya, Status and Urutkan, and no Mode", () => {
    renderBar();

    const labels = pillRow()
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));

    expect(labels).toEqual([
      "Kategori",
      "Ukuran tim",
      "Lokasi",
      "Untuk",
      "Biaya",
      "Status",
      "Urutkan",
    ]);
  });

  it("offers Gratis and Berbayar in the Biaya menu, with the slider only under Berbayar", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Biaya" }));
    const menu = within(screen.getByRole("dialog", { name: "Biaya" }));

    expect(menu.getByRole("button", { name: "Gratis" })).toBeTruthy();
    expect(menu.getByRole("button", { name: "Berbayar" })).toBeTruthy();
    expect(menu.queryByRole("slider")).toBeNull();

    fireEvent.click(menu.getByRole("button", { name: "Berbayar" }));

    expect(menu.getByRole("group", { name: "Rentang biaya" })).toBeTruthy();
    expect(menu.getByRole("slider", { name: "Biaya minimum" })).toBeTruthy();
    expect(menu.getByRole("slider", { name: "Biaya maksimum" })).toBeTruthy();
    expect(sliderSummaryIn("Biaya")).toBe(`${rupiah("0")} sampai ${rupiah("250.000")}+`);
    expect(menu.getByRole("button", { name: "Terapkan" })).toBeTruthy();
  });

  it("applies Gratis with Terapkan and writes fee=free", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Biaya" }));
    const menu = within(screen.getByRole("dialog", { name: "Biaya" }));

    fireEvent.click(menu.getByRole("button", { name: "Gratis" }));
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(menu.getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions?fee=free");
  });

  it("applies Berbayar over the whole track as fee=paid alone", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Biaya" }));
    const menu = within(screen.getByRole("dialog", { name: "Biaya" }));

    fireEvent.click(menu.getByRole("button", { name: "Berbayar" }));
    fireEvent.click(menu.getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions?fee=paid");
  });

  it("applies a narrowed price range only when Terapkan is pressed", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Biaya" }));
    const menu = within(screen.getByRole("dialog", { name: "Biaya" }));

    fireEvent.click(menu.getByRole("button", { name: "Berbayar" }));
    pressKey(menu.getByRole("slider", { name: "Biaya minimum" }), "ArrowRight");
    pressKey(menu.getByRole("slider", { name: "Biaya maksimum" }), "ArrowLeft", 6);
    expect(sliderSummaryIn("Biaya")).toBe(`${rupiah("25.000")} sampai ${rupiah("100.000")}`);
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(menu.getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions?fee=paid&feeMin=25000&feeMax=100000");
  });

  it("never lets the max handle go below Rp 25.000", () => {
    renderBar({ fee: "paid", feeMax: "50000" });
    fireEvent.click(pillRow().getByRole("button", { name: `Biaya: sampai ${rupiah("50.000")}` }));
    const menu = within(screen.getByRole("dialog", { name: "Biaya" }));

    pressKey(menu.getByRole("slider", { name: "Biaya maksimum" }), "Home");

    expect(menu.getByRole("slider", { name: "Biaya maksimum" }).getAttribute("aria-valuenow")).toBe(
      "25000",
    );
  });

  it("takes the filter off when the chosen choice is pressed again", () => {
    renderBar({ fee: "free" });
    fireEvent.click(pillRow().getByRole("button", { name: "Biaya: Gratis" }));
    const menu = within(screen.getByRole("dialog", { name: "Biaya" }));

    expect(menu.getByRole("button", { name: "Gratis" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(menu.getByRole("button", { name: "Gratis" }));
    fireEvent.click(menu.getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions");
  });

  it("drops the price range from the address when Gratis replaces Berbayar", () => {
    renderBar({ fee: "paid", feeMin: "25000", feeMax: "100000", q: "lomba" });
    fireEvent.click(
      pillRow().getByRole("button", {
        name: `Biaya: ${rupiah("25.000")} sampai ${rupiah("100.000")}`,
      }),
    );
    const menu = within(screen.getByRole("dialog", { name: "Biaya" }));

    fireEvent.click(menu.getByRole("button", { name: "Gratis" }));
    fireEvent.click(menu.getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions?fee=free&q=lomba");
  });

  it.each([
    [{ fee: "free" }, "Biaya: Gratis"],
    [{ fee: "paid" }, "Biaya: Berbayar"],
    [
      { fee: "paid", feeMin: "25000", feeMax: "100000" },
      `Biaya: ${rupiah("25.000")} sampai ${rupiah("100.000")}`,
    ],
    [{ fee: "paid", feeMin: "50000" }, `Biaya: mulai ${rupiah("50.000")}`],
    [{ fee: "paid", feeMax: "100000" }, `Biaya: sampai ${rupiah("100.000")}`],
  ])("words the active pill for %j as %s", (params, words) => {
    renderBar(params);

    expect(pillRow().getByRole("button", { name: words })).toBeTruthy();
  });

  it("shows no fee in the pill for an address that only carries a stray end", () => {
    renderBar({ feeMin: "25000", fee: "both" });

    expect(pillRow().getByRole("button", { name: "Biaya" })).toBeTruthy();
  });

  it("changes the address with the chosen location and clears it with Semua lokasi", () => {
    const first = renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Lokasi" }));
    fireEvent.click(screen.getByRole("option", { name: "Online" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?location=online");

    first.unmount();
    renderBar({ location: "online" });
    fireEvent.click(pillRow().getByRole("button", { name: "Lokasi: Online" }));
    fireEvent.click(screen.getByRole("option", { name: "Semua lokasi" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions");
  });

  it("ticks audience levels in a menu with Umum fixed, and applies them with Terapkan", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Untuk" }));

    const menu = within(screen.getByRole("dialog", { name: "Untuk" }));
    const umum = menu.getByRole("checkbox", { name: /^Umum/ }) as HTMLInputElement;
    expect(umum.checked).toBe(true);
    expect(umum.disabled).toBe(true);

    fireEvent.click(menu.getByRole("checkbox", { name: "Mahasiswa" }));
    fireEvent.click(menu.getByRole("checkbox", { name: "SMP" }));
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.click(menu.getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions?audience=mahasiswa%2Csmp");
  });

  it("shows the applied audience in its pill and lets the ticks be undone", () => {
    renderBar({ audience: "smp,mahasiswa" });

    fireEvent.click(pillRow().getByRole("button", { name: "Untuk: Mahasiswa, SMP" }));
    const menu = within(screen.getByRole("dialog", { name: "Untuk" }));
    fireEvent.click(menu.getByRole("checkbox", { name: "Mahasiswa" }));
    fireEvent.click(menu.getByRole("checkbox", { name: "SMP" }));
    fireEvent.click(menu.getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions");
  });

  it("closes the audience menu on Escape without changing the address", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Untuk" }));

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Untuk" }), { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Untuk" })).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
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
    fireEvent.click(pillRow().getByRole("button", { name: "Ukuran tim: 2 sampai 4" }));
    const menu = screen.getByRole("dialog", { name: "Ukuran tim" });

    pressKey(within(menu).getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    fireEvent.click(within(menu).getByRole("button", { name: "Terapkan" }));

    expect(mockPush).toHaveBeenCalledWith(
      "/competitions?q=lomba&sort=deadline_asc&teamMin=3&teamMax=4",
    );
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
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    fireEvent.click(pillRow().getByRole("button", { name: "Lokasi" }));
    expect(
      screen.getByRole("listbox", {}).closest("[data-align]")?.getAttribute("data-align"),
    ).toBe("end");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    fireEvent.click(pillRow().getByRole("button", { name: "Untuk" }));
    expect(screen.getByRole("dialog", { name: "Untuk" }).getAttribute("data-align")).toBe("end");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    fireEvent.click(pillRow().getByRole("button", { name: "Biaya" }));
    expect(screen.getByRole("dialog", { name: "Biaya" }).getAttribute("data-align")).toBe("end");
  });
});

describe("the phone chip row", () => {
  it("starts with Filter, then Urutkan, Kategori, Dibuka, Online and Gratis", () => {
    renderBar();

    const labels = phoneRow()
      .getAllByRole("button")
      .map((button) => button.textContent);

    expect(labels).toEqual(["Filter", "Urutkan", "Kategori", "Dibuka", "Online", "Gratis"]);
  });

  it("toggles the free fee with Gratis", () => {
    const first = renderBar();
    fireEvent.click(phoneRow().getByRole("button", { name: "Gratis" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?fee=free");

    first.unmount();
    renderBar({ fee: "free" });
    const pressed = phoneRow().getByRole("button", { name: "Gratis" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(mockPush).toHaveBeenLastCalledWith("/competitions");
  });

  it("replaces a paid range with the free fee when Gratis is pressed", () => {
    renderBar({ fee: "paid", feeMin: "25000" });

    fireEvent.click(phoneRow().getByRole("button", { name: "Gratis" }));

    expect(mockPush).toHaveBeenLastCalledWith("/competitions?fee=free");
  });

  it("shows a removable chip for the fee, worded like the pill, and clears its range with it", () => {
    renderBar({ fee: "paid", feeMin: "25000", feeMax: "100000" });
    const applied = within(screen.getByRole("list", { name: "Filter yang dipakai" }));
    const words = `Biaya: ${rupiah("25.000")} sampai ${rupiah("100.000")}`;

    expect(applied.getByRole("button", { name: `Hapus filter ${words}` })).toBeTruthy();
    expect(phoneRow().getByRole("button", { name: "Filter (1)" })).toBeTruthy();

    fireEvent.click(applied.getByRole("button", { name: `Hapus filter ${words}` }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions");
  });

  it.each([
    [{ fee: "free" }, "Biaya: Gratis"],
    [{ fee: "paid" }, "Biaya: Berbayar"],
    [{ fee: "paid", feeMin: "50000" }, `Biaya: mulai ${rupiah("50.000")}`],
    [{ fee: "paid", feeMax: "100000" }, `Biaya: sampai ${rupiah("100.000")}`],
  ])("words the applied chip for %j as %s", (params, words) => {
    renderBar(params);

    expect(
      within(screen.getByRole("list", { name: "Filter yang dipakai" })).getByRole("button", {
        name: `Hapus filter ${words}`,
      }),
    ).toBeTruthy();
  });

  it("clears the fee with Hapus semua", () => {
    renderBar({ fee: "paid", feeMin: "25000", q: "x" });

    fireEvent.click(phoneRow().getByRole("button", { name: "Hapus semua" }));

    expect(mockPush).toHaveBeenLastCalledWith("/competitions?q=x");
  });

  it("toggles the location to online with Online", () => {
    const first = renderBar();
    fireEvent.click(phoneRow().getByRole("button", { name: "Online" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?location=online");

    first.unmount();
    renderBar({ location: "online" });
    const pressed = phoneRow().getByRole("button", { name: "Online" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(mockPush).toHaveBeenLastCalledWith("/competitions");
  });

  it("shows a removable chip for a location and an audience, and clears both with Hapus semua", () => {
    renderBar({ location: "hybrid", audience: "mahasiswa", q: "x" });
    const applied = within(screen.getByRole("list", { name: "Filter yang dipakai" }));

    expect(applied.getByRole("button", { name: "Hapus filter Lokasi: Hybrid" })).toBeTruthy();
    expect(applied.getByRole("button", { name: "Hapus filter Untuk: Mahasiswa" })).toBeTruthy();
    expect(phoneRow().getByRole("button", { name: "Filter (2)" })).toBeTruthy();

    fireEvent.click(applied.getByRole("button", { name: "Hapus filter Untuk: Mahasiswa" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?location=hybrid&q=x");

    fireEvent.click(applied.getByRole("button", { name: "Hapus semua" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?q=x");
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

describe("an old mode or teamSize link", () => {
  const chipNamed = (name: string) =>
    within(screen.getByRole("list", { name: "Filter yang dipakai" })).getByRole("button", { name });

  it("shows its range in the pill, in the sheet and as a removable chip", () => {
    renderBar({ mode: "team" });

    expect(pillRow().getByRole("button", { name: "Ukuran tim: 2 sampai 10+" })).toBeTruthy();
    expect(chipNamed("Hapus filter Ukuran tim: 2 sampai 10+")).toBeTruthy();
    expect(phoneRow().getByRole("button", { name: "Filter (1)" })).toBeTruthy();

    openSheet();
    expect(
      sheet().getByRole("slider", { name: "Ukuran tim minimum" }).getAttribute("aria-valuenow"),
    ).toBe("2");
    expect(
      sheet().getByRole("slider", { name: "Ukuran tim maksimum" }).getAttribute("aria-valuenow"),
    ).toBe("10");
  });

  it("shows no range for mode both", () => {
    renderBar({ mode: "both" });

    expect(pillRow().getByRole("button", { name: "Ukuran tim" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Filter yang dipakai" })).toBeNull();
  });

  it("is cleared by removing its chip, which takes mode out of the address", () => {
    renderBar({ mode: "team", category: "debate" });

    fireEvent.click(chipNamed("Hapus filter Ukuran tim: 2 sampai 10+"));

    expect(mockPush).toHaveBeenLastCalledWith("/competitions?category=debate");
  });

  it.each([
    {
      change: "picking a category in the pill row",
      params: { mode: "team" },
      act: () => {
        fireEvent.click(pillRow().getByRole("button", { name: "Kategori" }));
        fireEvent.click(screen.getByRole("option", { name: "Debat" }));
      },
      expected: "/competitions?teamMin=2&category=debate",
    },
    {
      change: "pressing Dibuka",
      params: { mode: "individual", teamSize: "solo" },
      act: () => fireEvent.click(phoneRow().getByRole("button", { name: "Dibuka" })),
      expected: "/competitions?teamMax=1&status=open",
    },
    {
      change: "applying the sheet",
      params: { mode: "team", teamSize: "large" },
      act: () => {
        openSheet();
        fireEvent.click(sheet().getByRole("radio", { name: "Dibuka" }));
        fireEvent.click(sheetButton());
      },
      expected: "/competitions?teamMin=5&status=open&sort=created_desc",
    },
    {
      change: "applying a range in the pill row",
      params: { mode: "team" },
      act: () => {
        fireEvent.click(pillRow().getByRole("button", { name: "Ukuran tim: 2 sampai 10+" }));
        const menu = screen.getByRole("dialog", { name: "Ukuran tim" });
        pressKey(within(menu).getByRole("slider", { name: "Ukuran tim maksimum" }), "ArrowLeft");
        fireEvent.click(within(menu).getByRole("button", { name: "Terapkan" }));
      },
      expected: "/competitions?teamMin=2&teamMax=9",
    },
  ])(
    "leaves no mode or teamSize in the address after $change",
    ({ params, act: change, expected }) => {
      renderBar(params);

      change();

      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith(expected);
      const pushed = String(mockPush.mock.calls[0]![0]);
      expect(pushed).not.toMatch(/mode=|teamSize=/);
    },
  );

  it("clears mode and teamSize with Reset in the sheet", () => {
    renderBar({ mode: "team", teamSize: "small" });
    openSheet();

    fireEvent.click(sheet().getByRole("button", { name: "Reset" }));
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith("/competitions?sort=created_desc");
  });

  it("rewrites a reversed range as the range the slider shows", () => {
    renderBar({ teamMin: "7", teamMax: "3" });

    expect(pillRow().getByRole("button", { name: "Ukuran tim: 3 sampai 3" })).toBeTruthy();
    fireEvent.click(phoneRow().getByRole("button", { name: "Dibuka" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions?teamMin=3&teamMax=3&status=open");
  });
});

describe("the phone filter sheet", () => {
  it("opens full height with a title, a close button, Reset and the seven sections", () => {
    renderBar();
    openSheet();

    const dialog = screen.getByRole("dialog", { name: "Filter" });
    expect(dialog.getAttribute("data-height")).toBe("full");
    expect(sheet().getByRole("heading", { name: "Filter" })).toBeTruthy();
    expect(sheet().getByRole("button", { name: "Tutup" })).toBeTruthy();
    expect(sheet().getByRole("button", { name: "Reset" })).toBeTruthy();
    const sections = ["Kategori", "Ukuran tim", "Lokasi", "Untuk", "Biaya", "Status", "Urutkan"];
    for (const section of sections) {
      expect(sheet().getByRole("heading", { name: section })).toBeTruthy();
    }
    expect(sheet().getByRole("textbox", { name: "Cari kategori" })).toBeTruthy();
  });

  it("puts the Biaya section after Untuk and before Status", () => {
    renderBar();
    openSheet();

    const headings = sheet()
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);

    expect(headings).toEqual([
      "Kategori",
      "Ukuran tim",
      "Lokasi",
      "Untuk",
      "Biaya",
      "Status",
      "Urutkan",
    ]);
  });

  it("applies a fee range from the sheet with Tampilkan", () => {
    renderBar();
    openSheet();

    fireEvent.click(sheet().getByRole("button", { name: "Berbayar" }));
    pressKey(sheet().getByRole("slider", { name: "Biaya minimum" }), "ArrowRight", 2);
    pressKey(sheet().getByRole("slider", { name: "Biaya maksimum" }), "ArrowLeft", 5);
    expect(sliderSummaryIn("Filter")).toBe(`${rupiah("50.000")} sampai ${rupiah("125.000")}`);
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith(
      "/competitions?fee=paid&feeMin=50000&feeMax=125000&sort=created_desc",
    );
  });

  it("starts the Biaya section from the address, and Reset takes the fee off", () => {
    renderBar({ fee: "paid", feeMin: "25000", feeMax: "100000" });
    openSheet();

    expect(sheet().getByRole("button", { name: "Berbayar" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      sheet().getByRole("slider", { name: "Biaya minimum" }).getAttribute("aria-valuenow"),
    ).toBe("25000");
    expect(
      sheet().getByRole("slider", { name: "Biaya maksimum" }).getAttribute("aria-valuenow"),
    ).toBe("100000");

    fireEvent.click(sheet().getByRole("button", { name: "Reset" }));
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith("/competitions?sort=created_desc");
  });

  it("applies a location and ticked audience levels together with Tampilkan", () => {
    renderBar();
    openSheet();

    fireEvent.click(sheet().getByRole("radio", { name: "Offline" }));
    fireEvent.click(sheet().getByRole("checkbox", { name: "SD" }));
    fireEvent.click(sheet().getByRole("checkbox", { name: "Mahasiswa" }));
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith(
      "/competitions?sort=created_desc&location=offline&audience=mahasiswa%2Csd",
    );
  });

  it("starts from the location and audience in the address, with Umum ticked and fixed", () => {
    renderBar({ location: "hybrid", audience: "smp" });
    openSheet();

    expect(sheet().getByRole("radio", { name: "Hybrid" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect((sheet().getByRole("checkbox", { name: "SMP" }) as HTMLInputElement).checked).toBe(true);
    const umum = sheet().getByRole("checkbox", { name: /^Umum/ }) as HTMLInputElement;
    expect(umum.checked).toBe(true);
    expect(umum.disabled).toBe(true);
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
      "/competitions?teamMin=2&category=debate&status=open&sort=created_desc",
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

  it("asks with the pending location and audience, so the count matches the list", async () => {
    useTimers();
    renderBar({}, 40);
    openSheet();

    fireEvent.click(sheet().getByRole("radio", { name: "Online" }));
    fireEvent.click(sheet().getByRole("checkbox", { name: "SMP" }));
    await settle(300);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const requested = new URL(String(mockFetch.mock.calls[0]![0]), "http://localhost");
    expect(requested.searchParams.get("location")).toBe("online");
    expect(requested.searchParams.get("audience")).toBe("smp");
  });

  it("asks with the pending fee filter, so the sheet count matches the list", async () => {
    useTimers();
    renderBar({}, 40);
    openSheet();

    fireEvent.click(sheet().getByRole("button", { name: "Berbayar" }));
    pressKey(sheet().getByRole("slider", { name: "Biaya minimum" }), "ArrowRight", 4);
    await settle(300);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const requested = new URL(String(mockFetch.mock.calls[0]![0]), "http://localhost");
    expect(requested.searchParams.get("fee")).toBe("paid");
    expect(requested.searchParams.get("feeMin")).toBe("100000");
    expect(requested.searchParams.has("feeMax")).toBe(false);
  });

  it("asks with the free fee and without the ends of a range it replaced", async () => {
    useTimers();
    renderBar({ fee: "paid", feeMin: "25000", feeMax: "100000" }, 40);
    openSheet();

    fireEvent.click(sheet().getByRole("button", { name: "Gratis" }));
    await settle(300);

    const requested = new URL(String(mockFetch.mock.calls[0]![0]), "http://localhost");
    expect(requested.searchParams.get("fee")).toBe("free");
    expect(requested.searchParams.has("feeMin")).toBe(false);
    expect(requested.searchParams.has("feeMax")).toBe(false);
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

  it("keeps the team range from the address in the request when another filter changes", async () => {
    useTimers();
    renderBar({ teamMin: "3", teamMax: "6" }, 40);
    openSheet();

    fireEvent.click(sheet().getByRole("radio", { name: "Dibuka" }));
    await settle(300);

    const requested = new URL(String(mockFetch.mock.calls[0]![0]), "http://localhost");
    expect(requested.searchParams.get("status")).toBe("open");
    expect(requested.searchParams.get("teamMin")).toBe("3");
    expect(requested.searchParams.get("teamMax")).toBe("6");
  });

  it("asks for an old mode link as its range and without mode or teamSize", async () => {
    useTimers();
    renderBar({ mode: "team", teamSize: "small" }, 40);
    openSheet();

    fireEvent.click(sheet().getByRole("radio", { name: "Dibuka" }));
    await settle(300);

    const requested = new URL(String(mockFetch.mock.calls[0]![0]), "http://localhost");
    expect(requested.searchParams.get("teamMin")).toBe("2");
    expect(requested.searchParams.get("teamMax")).toBe("4");
    expect(requested.searchParams.has("mode")).toBe(false);
    expect(requested.searchParams.has("teamSize")).toBe(false);
  });

  it("aborts a request that a newer change supersedes and never shows its answer", async () => {
    useTimers();
    const requests: Array<{ signal: AbortSignal; answer: (total: number) => void }> = [];
    // Like the browser's fetch, a request rejects as soon as its signal aborts.
    mockFetch.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
          requests.push({
            signal: init.signal,
            answer: (total) => resolve({ ok: true, json: async () => ({ meta: { total } }) }),
          });
        }),
    );
    renderBar({}, 40);
    openSheet();
    const minHandle = sheet().getByRole("slider", { name: "Ukuran tim minimum" });

    pressKey(minHandle, "ArrowRight");
    await settle(300);
    pressKey(minHandle, "ArrowRight");
    await settle(300);

    expect(requests).toHaveLength(2);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests[1]!.signal.aborted).toBe(false);

    requests[0]!.answer(99);
    await settle(0);
    expect(sheetButton().textContent).toBe("Tampilkan 40 lomba");
    expect(sheetButton().getAttribute("aria-busy")).toBe("true");

    requests[1]!.answer(7);
    await settle(0);
    expect(sheetButton().textContent).toBe("Tampilkan 7 lomba");
    expect(sheetButton().hasAttribute("aria-busy")).toBe(false);
  });

  it("aborts the request in flight when the sheet closes", async () => {
    useTimers();
    let signalOfRequest: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      signalOfRequest = init.signal;
      return new Promise(() => undefined);
    });
    renderBar({}, 40);
    openSheet();

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);
    fireEvent.click(sheet().getByRole("button", { name: "Tutup" }));

    expect(signalOfRequest?.aborted).toBe(true);
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

    expect(mockPush).toHaveBeenCalledWith("/competitions?teamMin=2&sort=created_desc");
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
