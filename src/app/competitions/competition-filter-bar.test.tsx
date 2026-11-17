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
      <CompetitionFilterBar
        params={params}
        total={total}
        resultCount={<h2>{total} kompetisi ditemukan</h2>}
      />
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
const phoneBar = () => within(document.querySelector<HTMLElement>(".filter-phone")!);
const sheet = () => within(screen.getByRole("dialog", { name: "Filter" }));

const pressKey = (element: HTMLElement, key: string, times = 1) => {
  for (let count = 0; count < times; count++) fireEvent.keyDown(element, { key });
};

const sectionHeader = (name: string) =>
  sheet().getByRole("button", { name: new RegExp(`^${name}( ·|$)`) });

const isSectionOpen = (name: string): boolean =>
  sectionHeader(name).getAttribute("aria-expanded") === "true";

// Opens a section the way a reader does, and leaves one that is already open as it is.
const expandSection = (name: string) => {
  if (!isSectionOpen(name)) fireEvent.click(sectionHeader(name));
};

const openSheet = (section?: string) => {
  fireEvent.click(phoneBar().getByRole("button", { name: /^Filter/ }));
  if (section) expandSection(section);
};

const sheetButton = () => sheet().getByRole("button", { name: /^Tampilkan/ });

const openSectionNames = (): string[] =>
  sheet()
    .getAllByRole("heading", { level: 3 })
    .filter((heading) => heading.querySelector("[aria-expanded='true']"))
    .map((heading) => heading.textContent ?? "");

const SECTION_NAMES = ["Kategori", "Ukuran tim", "Lokasi", "Untuk", "Biaya", "Status", "Urutkan"];

describe("the desktop row", () => {
  it("shows Kategori, Status, Lokasi, the Filter pill and Urutkan, and no pill for the rest", () => {
    renderBar();

    const labels = pillRow()
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);

    expect(labels).toEqual(["Kategori", "Status", "Lokasi", "Filter", "Urutkan"]);
  });

  it("keeps Urutkan on its own at the right end of the row", () => {
    renderBar();

    const sortSlot = document.querySelector(".filter-toolbar-sort")!;

    expect(sortSlot.parentElement?.lastElementChild).toBe(sortSlot);
    expect(within(sortSlot as HTMLElement).getByRole("button", { name: "Urutkan" })).toBeTruthy();
  });

  it("draws the phone bar outside the toolbar, so its position is the screen's", () => {
    renderBar();

    expect(
      document.querySelector(".filter-toolbar")!.contains(document.querySelector(".filter-phone")),
    ).toBe(false);
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

  it("keeps the full value of a pill in its name, so a cut label still says what is set", () => {
    renderBar({ status: "all" });

    expect(pillRow().getByRole("button", { name: "Status: Semua termasuk selesai" })).toBeTruthy();
  });

  it("applies a status from its pill without opening the panel", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Status" }));
    fireEvent.click(screen.getByRole("option", { name: "Dibuka" }));

    expect(mockPush).toHaveBeenLastCalledWith("/competitions?status=open");
    expect(screen.queryByRole("dialog", { name: "Filter" })).toBeNull();
  });

  it("applies a sort from its pill and keeps the filters", () => {
    renderBar({ category: "debate" });
    fireEvent.click(pillRow().getByRole("button", { name: "Urutkan" }));
    fireEvent.click(screen.getByRole("option", { name: "Deadline terdekat" }));

    expect(mockPush).toHaveBeenLastCalledWith("/competitions?category=debate&sort=deadline_asc");
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

  it("opens the front menus from their left edge and Urutkan's from its right edge", () => {
    renderBar();

    const expectedAlign: Array<[string, string | undefined]> = [
      ["Kategori", undefined],
      ["Status", undefined],
      ["Lokasi", undefined],
      ["Urutkan", "end"],
    ];
    for (const [name, align] of expectedAlign) {
      fireEvent.click(pillRow().getByRole("button", { name }));
      const popup = screen
        .getByRole(name === "Kategori" ? "combobox" : "listbox", {})
        .closest("[data-align], .filter-dropdown-menu");
      expect(popup?.getAttribute("data-align") ?? undefined).toBe(align);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    }
  });
});

describe("the Filter pill", () => {
  const WITH_THREE_FILTERS = {
    category: "debate",
    status: "open",
    teamMin: "2",
    sort: "deadline_asc",
  };

  it("shows no number while no filter is set, and a set sort is no filter", () => {
    renderBar({ sort: "deadline_asc" });

    expect(pillRow().getByRole("button", { name: "Filter" })).toBeTruthy();
    expect(phoneBar().getByRole("button", { name: "Filter" })).toBeTruthy();
    expect(document.querySelector(".filter-count-badge")).toBeNull();
  });

  it("counts every set filter except the sort, on the desktop row and on the phone bar", () => {
    renderBar(WITH_THREE_FILTERS);

    const desktopPill = pillRow().getByRole("button", { name: "Filter (3)" });
    const phonePill = phoneBar().getByRole("button", { name: "Filter (3)" });

    expect(desktopPill.querySelector(".filter-count-badge")?.textContent).toBe("3");
    expect(phonePill.querySelector(".filter-count-badge")?.textContent).toBe("3");
  });

  it("counts a fee, an audience and a location as one filter each", () => {
    renderBar({ fee: "paid", feeMin: "25000", audience: "smp,mahasiswa", location: "hybrid" });

    expect(pillRow().getByRole("button", { name: "Filter (3)" })).toBeTruthy();
  });

  it("opens the panel on Kategori when no filter is set", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Filter" }));

    expect(openSectionNames()).toEqual(["Kategori"]);
  });

  it("opens the panel on Kategori when only the sort is set", () => {
    renderBar({ sort: "deadline_desc" });
    fireEvent.click(pillRow().getByRole("button", { name: "Filter" }));

    expect(openSectionNames()).toEqual(["Kategori"]);
  });

  it.each([
    [{ status: "open", location: "online" }, "Lokasi"],
    [{ fee: "free", status: "open" }, "Biaya"],
    [{ audience: "smp", status: "closed" }, "Untuk"],
    [{ teamMax: "4", fee: "free" }, "Ukuran tim"],
    [{ category: "debate", teamMax: "4" }, "Kategori"],
    [{ status: "closing", sort: "deadline_asc" }, "Status"],
  ])(
    "opens the panel for %j on %s, the first section in panel order with a filter set",
    (params, name) => {
      renderBar(params);
      fireEvent.click(phoneBar().getByRole("button", { name: /^Filter/ }));

      expect(openSectionNames()).toHaveLength(1);
      expect(isSectionOpen(name)).toBe(true);
    },
  );

  it("does not pull focus into the Kategori search field when it opens the panel", () => {
    renderBar();
    fireEvent.click(pillRow().getByRole("button", { name: "Filter" }));

    expect(document.activeElement).not.toBe(
      sheet().getByRole("textbox", { name: "Cari kategori" }),
    );
  });
});

describe("the trash button", () => {
  const EVERYTHING_SET = {
    q: "lomba",
    category: "debate",
    location: "online",
    teamMin: "2",
    fee: "paid",
    feeMin: "25000",
    audience: "smp",
    status: "open",
    mode: "team",
    teamSize: "small",
    sort: "deadline_asc",
  };

  it("is not in the row while no filter is set", () => {
    renderBar({ q: "lomba", sort: "deadline_asc" });

    expect(pillRow().queryByRole("button", { name: "Hapus semua filter" })).toBeNull();
  });

  it("appears at the end of the front row, after the Filter pill, once a filter is set", () => {
    renderBar({ category: "debate" });

    const trash = pillRow().getByRole("button", { name: "Hapus semua filter" });
    const filterPill = pillRow().getByRole("button", { name: "Filter (1)" });

    expect(trash.textContent).toBe("");
    expect(trash.getAttribute("title") ?? trash.getAttribute("data-tooltip")).toBe(
      "Hapus semua filter",
    );
    expect(
      filterPill.compareDocumentPosition(trash) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("clears every filter and keeps the search term and the sort", () => {
    renderBar(EVERYTHING_SET);

    fireEvent.click(pillRow().getByRole("button", { name: "Hapus semua filter" }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/competitions?q=lomba&sort=deadline_asc");
  });

  it("clears an old mode and teamSize link too", () => {
    renderBar({ mode: "team", teamSize: "small", category: "debate" });

    fireEvent.click(pillRow().getByRole("button", { name: "Hapus semua filter" }));

    expect(mockPush).toHaveBeenLastCalledWith("/competitions");
  });

  it("is not on the phone bar, which has the Filter count and the panel", () => {
    renderBar({ category: "debate" });

    expect(phoneBar().queryByRole("button", { name: "Hapus semua filter" })).toBeNull();
  });
});

describe("the phone bar", () => {
  it("starts with Filter, then Urutkan, Kategori, Dibuka, Online and Gratis", () => {
    renderBar();

    const labels = phoneBar()
      .getAllByRole("button")
      .map((button) => button.textContent);

    expect(labels).toEqual(["Filter", "Urutkan", "Kategori", "Dibuka", "Online", "Gratis"]);
  });

  it("fixes the Filter pill outside the sideways row and fills it, unlike the other chips", () => {
    renderBar();

    const bar = document.querySelector<HTMLElement>(".filter-phone")!;
    const row = bar.querySelector<HTMLElement>(".filter-phone-row")!;
    const filterPill = phoneBar().getByRole("button", { name: "Filter" });

    expect(filterPill.parentElement).toBe(bar);
    expect(filterPill.classList.contains("filter-phone-pill")).toBe(true);
    expect(row.contains(filterPill)).toBe(false);
    for (const chip of within(row).getAllByRole("button")) {
      expect(chip.classList.contains("filter-phone-pill")).toBe(false);
      expect(chip.parentElement).toBe(row);
    }
  });

  it("toggles the free fee with Gratis", () => {
    const first = renderBar();
    fireEvent.click(phoneBar().getByRole("button", { name: "Gratis" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?fee=free");

    first.unmount();
    renderBar({ fee: "free" });
    const pressed = phoneBar().getByRole("button", { name: "Gratis" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(mockPush).toHaveBeenLastCalledWith("/competitions");
  });

  it("replaces a paid range with the free fee when Gratis is pressed", () => {
    renderBar({ fee: "paid", feeMin: "25000" });

    fireEvent.click(phoneBar().getByRole("button", { name: "Gratis" }));

    expect(mockPush).toHaveBeenLastCalledWith("/competitions?fee=free");
  });

  it("toggles the location to online with Online, which now means online only", () => {
    const first = renderBar();
    fireEvent.click(phoneBar().getByRole("button", { name: "Online" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?location=online");

    first.unmount();
    renderBar({ location: "online" });
    const pressed = phoneBar().getByRole("button", { name: "Online" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(mockPush).toHaveBeenLastCalledWith("/competitions");
  });

  it("does not mark Online as chosen for a hybrid competition filter", () => {
    renderBar({ location: "hybrid" });

    expect(phoneBar().getByRole("button", { name: "Online" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("toggles the status to open with Dibuka", () => {
    const first = renderBar();
    fireEvent.click(phoneBar().getByRole("button", { name: "Dibuka" }));
    expect(mockPush).toHaveBeenLastCalledWith("/competitions?status=open");

    first.unmount();
    renderBar({ status: "open" });
    const pressed = phoneBar().getByRole("button", { name: "Dibuka" });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(mockPush).toHaveBeenLastCalledWith("/competitions");
  });

  it("opens the panel on the section of the chip pressed, with focus in it", () => {
    const first = renderBar();
    fireEvent.click(phoneBar().getByRole("button", { name: "Kategori" }));
    expect(openSectionNames()).toEqual(["Kategori"]);
    expect(document.activeElement).toBe(sheet().getByRole("textbox", { name: "Cari kategori" }));
    fireEvent.click(sheet().getByRole("button", { name: "Tutup" }));
    first.unmount();

    renderBar({ sort: "deadline_asc" });
    fireEvent.click(phoneBar().getByRole("button", { name: "Urutkan" }));
    expect(openSectionNames()).toEqual(["Urutkan · Deadline terdekat"]);
    expect(document.activeElement).toBe(sheet().getByRole("radio", { name: "Deadline terdekat" }));
  });
});

describe("the applied-filter chips", () => {
  it("are gone from the phone bar and from the desktop row, with their Hapus semua", () => {
    renderBar({ category: "debate", status: "open", teamMin: "2", teamMax: "4", q: "x" });

    expect(screen.queryByRole("list", { name: "Filter yang dipakai" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Hapus filter / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hapus semua" })).toBeNull();
    expect(document.querySelector(".filter-phone-applied")).toBeNull();
  });
});

describe("an old mode or teamSize link", () => {
  it("counts as the range it stands for, in the Filter pill and in the panel", () => {
    renderBar({ mode: "team" });

    expect(pillRow().getByRole("button", { name: "Filter (1)" })).toBeTruthy();
    expect(phoneBar().getByRole("button", { name: "Filter (1)" })).toBeTruthy();

    openSheet();
    expect(sectionHeader("Ukuran tim").textContent).toBe("Ukuran tim · 2 sampai 10+");
    expect(
      sheet().getByRole("slider", { name: "Ukuran tim minimum" }).getAttribute("aria-valuenow"),
    ).toBe("2");
    expect(
      sheet().getByRole("slider", { name: "Ukuran tim maksimum" }).getAttribute("aria-valuenow"),
    ).toBe("10");
  });

  it("shows no range for mode both", () => {
    renderBar({ mode: "both" });

    expect(pillRow().getByRole("button", { name: "Filter" })).toBeTruthy();
    expect(document.querySelector(".filter-count-badge")).toBeNull();
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
      act: () => fireEvent.click(phoneBar().getByRole("button", { name: "Dibuka" })),
      expected: "/competitions?teamMax=1&status=open",
    },
    {
      change: "applying the panel",
      params: { mode: "team", teamSize: "large" },
      act: () => {
        openSheet("Status");
        fireEvent.click(sheet().getByRole("radio", { name: "Dibuka" }));
        fireEvent.click(sheetButton());
      },
      expected: "/competitions?teamMin=5&status=open&sort=created_desc",
    },
    {
      change: "applying a range in the panel",
      params: { mode: "team" },
      act: () => {
        openSheet("Ukuran tim");
        pressKey(sheet().getByRole("slider", { name: "Ukuran tim maksimum" }), "ArrowLeft");
        fireEvent.click(sheetButton());
      },
      expected: "/competitions?teamMin=2&teamMax=9&sort=created_desc",
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

  it("clears mode and teamSize with the trash button in the panel", () => {
    renderBar({ mode: "team", teamSize: "small" });
    openSheet();

    fireEvent.click(sheet().getByRole("button", { name: "Hapus semua filter" }));
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith("/competitions?sort=created_desc");
  });

  it("rewrites a reversed range as the range the slider shows", () => {
    renderBar({ teamMin: "7", teamMax: "3" });

    openSheet();
    expect(sectionHeader("Ukuran tim").textContent).toBe("Ukuran tim · 3 sampai 3");
    fireEvent.click(sheet().getByRole("button", { name: "Tutup" }));
    fireEvent.click(phoneBar().getByRole("button", { name: "Dibuka" }));

    expect(mockPush).toHaveBeenCalledWith("/competitions?teamMin=3&teamMax=3&status=open");
  });
});

describe("the filter panel", () => {
  it("opens full height as a drawer with a title, a close button, the trash button and seven sections", () => {
    renderBar();
    openSheet();

    const dialog = screen.getByRole("dialog", { name: "Filter" });
    expect(dialog.getAttribute("data-height")).toBe("full");
    expect(dialog.getAttribute("data-side")).toBe("end");
    expect(sheet().getByRole("heading", { name: "Filter" })).toBeTruthy();
    expect(sheet().getByRole("button", { name: "Tutup" })).toBeTruthy();
    expect(sheet().getByRole("button", { name: "Hapus semua filter" })).toBeTruthy();
    expect(sheet().queryByRole("button", { name: "Reset" })).toBeNull();
    for (const section of SECTION_NAMES) {
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

    expect(headings).toEqual(SECTION_NAMES);
  });

  it("opens one section and collapses the rest", () => {
    renderBar();
    openSheet();

    expect(openSectionNames()).toEqual(["Kategori"]);
    for (const section of SECTION_NAMES.slice(1)) {
      expect(isSectionOpen(section)).toBe(false);
    }
    expect(sheet().queryByRole("slider", { name: "Ukuran tim minimum" })).toBeNull();
    expect(sheet().queryByRole("radio", { name: "Dibuka" })).toBeNull();
  });

  it("closes the open section when another one is opened, so only one is ever open", () => {
    renderBar();
    openSheet();

    fireEvent.click(sectionHeader("Ukuran tim"));
    expect(openSectionNames()).toEqual(["Ukuran tim"]);
    expect(sheet().getByRole("slider", { name: "Ukuran tim minimum" })).toBeTruthy();
    expect(sheet().queryByRole("textbox", { name: "Cari kategori" })).toBeNull();

    fireEvent.click(sectionHeader("Status"));
    expect(openSectionNames()).toEqual(["Status"]);
    expect(sheet().queryByRole("slider", { name: "Ukuran tim minimum" })).toBeNull();
  });

  it("collapses the open section when its own header is pressed, leaving none open", () => {
    renderBar();
    openSheet();

    fireEvent.click(sectionHeader("Kategori"));

    expect(openSectionNames()).toEqual([]);
  });

  it("links each header to its section with aria-expanded and aria-controls", () => {
    renderBar();
    openSheet();

    const header = sectionHeader("Lokasi");
    const panelId = header.getAttribute("aria-controls")!;

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(panelId)?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(panelId)?.hasAttribute("hidden")).toBe(false);
  });

  it("shows the current value after the name of a section, and only the name when nothing is set", () => {
    renderBar({
      category: "debate",
      teamMin: "2",
      teamMax: "5",
      location: "hybrid",
      audience: "smp,mahasiswa",
      fee: "free",
      status: "closing",
      sort: "deadline_asc",
    });
    openSheet();

    const headings = sheet()
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);

    expect(headings).toEqual([
      "Kategori · Debat",
      "Ukuran tim · 2 sampai 5",
      "Lokasi · Hybrid",
      "Untuk · Mahasiswa, SMP",
      "Biaya · Gratis",
      "Status · Segera ditutup",
      "Urutkan · Deadline terdekat",
    ]);
  });

  it("words the fee in its header like the slider does", () => {
    renderBar({ fee: "paid", feeMin: "25000", feeMax: "100000" });
    openSheet();

    expect(sectionHeader("Biaya").textContent).toBe(
      `Biaya · ${rupiah("25.000")} sampai ${rupiah("100.000")}`,
    );
  });

  it("follows the choices made in the panel, before they are applied", () => {
    renderBar();
    openSheet("Lokasi");

    fireEvent.click(sheet().getByRole("radio", { name: "Offline" }));

    expect(sectionHeader("Lokasi").textContent).toBe("Lokasi · Offline");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("reads Individu in place of 1 in the team words, in the header and under the slider", () => {
    renderBar();
    openSheet("Ukuran tim");

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim maksimum" }), "ArrowLeft", 5);

    expect(sectionHeader("Ukuran tim").textContent).toBe("Ukuran tim · Individu sampai 5");
    expect(sheet().getByText("Individu sampai 5")).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("reads Individu for both handles on 1, and keeps 2 sampai 5 as it was", () => {
    renderBar();
    openSheet("Ukuran tim");

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim maksimum" }), "Home");
    expect(sheet().getByText("Individu")).toBeTruthy();
    expect(sectionHeader("Ukuran tim").textContent).toBe("Ukuran tim · Individu");

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim maksimum" }), "ArrowRight", 4);
    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    expect(sectionHeader("Ukuran tim").textContent).toBe("Ukuran tim · 2 sampai 5");
  });

  it("reads the track's start as Individu and the top as 10+", () => {
    renderBar();
    openSheet("Ukuran tim");

    expect(
      sheet().getByRole("slider", { name: "Ukuran tim minimum" }).getAttribute("aria-valuetext"),
    ).toBe("Individu");
    expect(sheet().getByText("Individu sampai 10+")).toBeTruthy();
  });

  it("names the audience level Umum without a note, ticked and fixed", () => {
    renderBar();
    openSheet("Untuk");

    const umum = sheet().getByRole("checkbox", { name: "Umum" }) as HTMLInputElement;
    expect(umum.checked).toBe(true);
    expect(umum.disabled).toBe(true);
    expect(sheet().queryByText(/selalu termasuk/)).toBeNull();
  });

  it("offers Online, Offline and Hybrid as three separate choices", () => {
    renderBar();
    openSheet("Lokasi");

    const choices = within(sheet().getByRole("radiogroup", { name: "Lokasi" }))
      .getAllByRole("radio")
      .map((radio) => radio.textContent);

    expect(choices).toEqual(["Semua lokasi", "Online", "Offline", "Hybrid"]);
  });

  it("applies a fee range from the panel with Tampilkan", () => {
    renderBar();
    openSheet("Biaya");

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

  it("offers Gratis and Berbayar in Biaya, with the slider only under Berbayar", () => {
    renderBar();
    openSheet("Biaya");

    expect(sheet().getByRole("button", { name: "Gratis" })).toBeTruthy();
    expect(sheet().getByRole("button", { name: "Berbayar" })).toBeTruthy();
    expect(sheet().queryByRole("slider", { name: "Biaya minimum" })).toBeNull();

    fireEvent.click(sheet().getByRole("button", { name: "Berbayar" }));

    expect(sheet().getByRole("group", { name: "Rentang biaya" })).toBeTruthy();
    expect(sliderSummaryIn("Filter")).toBe(`${rupiah("0")} sampai ${rupiah("250.000")}+`);
  });

  it("never lets the max handle go below Rp 25.000", () => {
    renderBar({ fee: "paid", feeMax: "50000" });
    openSheet("Biaya");

    pressKey(sheet().getByRole("slider", { name: "Biaya maksimum" }), "Home");

    expect(
      sheet().getByRole("slider", { name: "Biaya maksimum" }).getAttribute("aria-valuenow"),
    ).toBe("25000");
  });

  it("takes the fee filter off when the chosen choice is pressed again", () => {
    renderBar({ fee: "free" });
    openSheet("Biaya");

    expect(sheet().getByRole("button", { name: "Gratis" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(sheet().getByRole("button", { name: "Gratis" }));
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith("/competitions?sort=created_desc");
  });

  it("drops the price range from the address when Gratis replaces Berbayar", () => {
    renderBar({ fee: "paid", feeMin: "25000", feeMax: "100000", q: "lomba" });
    openSheet("Biaya");

    fireEvent.click(sheet().getByRole("button", { name: "Gratis" }));
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith("/competitions?fee=free&q=lomba&sort=created_desc");
  });

  it("starts the Biaya section from the address, and the trash button takes the fee off", () => {
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

    fireEvent.click(sheet().getByRole("button", { name: "Hapus semua filter" }));
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith("/competitions?sort=created_desc");
  });

  it("applies a location and ticked audience levels together with Tampilkan", () => {
    renderBar();
    openSheet("Lokasi");

    fireEvent.click(sheet().getByRole("radio", { name: "Offline" }));
    expandSection("Untuk");
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
    openSheet("Lokasi");

    expect(sheet().getByRole("radio", { name: "Hybrid" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expandSection("Untuk");
    expect((sheet().getByRole("checkbox", { name: "SMP" }) as HTMLInputElement).checked).toBe(true);
    const umum = sheet().getByRole("checkbox", { name: "Umum" }) as HTMLInputElement;
    expect(umum.checked).toBe(true);
    expect(umum.disabled).toBe(true);
  });

  it("does not change the address until Tampilkan is pressed", () => {
    renderBar();
    openSheet("Ukuran tim");

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    expandSection("Status");
    fireEvent.click(sheet().getByRole("radio", { name: "Dibuka" }));
    expandSection("Kategori");
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
    openSheet("Status");
    fireEvent.click(sheet().getByRole("radio", { name: "Dibuka" }));

    fireEvent.click(sheet().getByRole("button", { name: "Tutup" }));
    expect(screen.queryByRole("dialog", { name: "Filter" })).toBeNull();

    openSheet("Status");
    fireEvent.click(sheet().getByRole("radio", { name: "Dibuka" }));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(screen.queryByRole("dialog", { name: "Filter" })).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("closes when a tap lands on the screen beside the drawer", () => {
    renderBar();
    openSheet();

    fireEvent.click(screen.getByRole("dialog", { name: "Filter" }).parentElement!);

    expect(screen.queryByRole("dialog", { name: "Filter" })).toBeNull();
  });

  it("starts from the filters already in the address", () => {
    renderBar({ category: "debate", status: "closing", teamMin: "3", teamMax: "6" });
    openSheet();

    expect(sheet().getByRole("radio", { name: "Debat" }).getAttribute("aria-checked")).toBe("true");
    expandSection("Ukuran tim");
    expect(
      sheet().getByRole("slider", { name: "Ukuran tim minimum" }).getAttribute("aria-valuenow"),
    ).toBe("3");
    expect(
      sheet().getByRole("slider", { name: "Ukuran tim maksimum" }).getAttribute("aria-valuenow"),
    ).toBe("6");
    expandSection("Status");
    expect(
      sheet().getByRole("radio", { name: "Segera ditutup" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("clears every filter with the trash button, keeps the sort, and still waits for Tampilkan", () => {
    renderBar({ category: "debate", status: "open", teamMin: "3", sort: "deadline_asc" });
    openSheet();

    fireEvent.click(sheet().getByRole("button", { name: "Hapus semua filter" }));
    expect(mockPush).not.toHaveBeenCalled();
    expect(sectionHeader("Kategori").textContent).toBe("Kategori");
    expect(sectionHeader("Urutkan").textContent).toBe("Urutkan · Deadline terdekat");
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith("/competitions?sort=deadline_asc");
  });

  it("finds a category by typing in the panel", () => {
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

  it("keeps what was typed in a section that is collapsed and opened again", () => {
    renderBar();
    openSheet();

    fireEvent.change(sheet().getByRole("textbox", { name: "Cari kategori" }), {
      target: { value: "deb" },
    });
    fireEvent.click(sectionHeader("Status"));
    fireEvent.click(sectionHeader("Kategori"));

    expect(
      (sheet().getByRole("textbox", { name: "Cari kategori" }) as HTMLInputElement).value,
    ).toBe("deb");
  });
});

describe("the live count on the panel's button", () => {
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
    openSheet("Ukuran tim");

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
    openSheet("Lokasi");

    fireEvent.click(sheet().getByRole("radio", { name: "Online" }));
    expandSection("Untuk");
    fireEvent.click(sheet().getByRole("checkbox", { name: "SMP" }));
    await settle(300);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const requested = new URL(String(mockFetch.mock.calls[0]![0]), "http://localhost");
    expect(requested.searchParams.get("location")).toBe("online");
    expect(requested.searchParams.get("audience")).toBe("smp");
  });

  it("asks with the pending fee filter, so the panel count matches the list", async () => {
    useTimers();
    renderBar({}, 40);
    openSheet("Biaya");

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
    openSheet("Biaya");

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
    openSheet("Ukuran tim");

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
    openSheet("Status");

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
    openSheet("Status");

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
    openSheet("Ukuran tim");
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

  it("aborts the request in flight when the panel closes", async () => {
    useTimers();
    let signalOfRequest: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      signalOfRequest = init.signal;
      return new Promise(() => undefined);
    });
    renderBar({}, 40);
    openSheet("Ukuran tim");

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);
    fireEvent.click(sheet().getByRole("button", { name: "Tutup" }));

    expect(signalOfRequest?.aborted).toBe(true);
  });

  it("keeps the last count and shows its spinner while the request is out", async () => {
    useTimers();
    mockFetch.mockReturnValue(new Promise(() => undefined));
    renderBar({}, 40);
    openSheet("Ukuran tim");

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);

    expect(sheetButton().textContent).toBe("Tampilkan 40 lomba");
    expect(sheetButton().getAttribute("aria-busy")).toBe("true");
  });

  it("can still apply while the count is loading", async () => {
    useTimers();
    mockFetch.mockReturnValue(new Promise(() => undefined));
    renderBar({}, 40);
    openSheet("Ukuran tim");

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);
    fireEvent.click(sheetButton());

    expect(mockPush).toHaveBeenCalledWith("/competitions?teamMin=2&sort=created_desc");
  });

  it("says Tampilkan hasil when the request fails", async () => {
    useTimers();
    mockFetch.mockRejectedValue(new Error("offline"));
    renderBar({}, 40);
    openSheet("Ukuran tim");

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);

    expect(sheetButton().textContent).toBe("Tampilkan hasil");
    expect(sheetButton().hasAttribute("aria-busy")).toBe(false);
  });

  it("says Tampilkan hasil when the route answers with an error status", async () => {
    useTimers();
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    renderBar({}, 40);
    openSheet("Ukuran tim");

    pressKey(sheet().getByRole("slider", { name: "Ukuran tim minimum" }), "ArrowRight");
    await settle(300);

    expect(sheetButton().textContent).toBe("Tampilkan hasil");
  });
});
