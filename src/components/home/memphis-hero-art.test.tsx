import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findGridUnitsOutsideClearing, MemphisHeroArt } from "@/components/home/memphis-hero-art";

const FIELD_WIDTH_PX = 1200;
const FIELD_HEIGHT_PX = 720;
const FIELD_LEFT_PX = 100;
const FIELD_TOP_PX = 50;
const CELL_PX = 60;
const COLUMNS = FIELD_WIDTH_PX / CELL_PX;
const ROWS = FIELD_HEIGHT_PX / CELL_PX;
const MIN_FILLED_SHARE = 0.8;
const TICKS_TO_RUN = 60;
const BLINK_INTERVAL_MS = 500;

// Box C in the field's own coordinates: 640 by 200 px, centred in the field.
const CLEARING_BOX = { left: 280, top: 260, right: 920, bottom: 460 };

const unitIndex = (col: number, row: number) => row * COLUMNS + col;

const rectOf = (box: { left: number; top: number; right: number; bottom: number }) => ({
  ...box,
  width: box.right - box.left,
  height: box.bottom - box.top,
});

// jsdom has no layout, matchMedia or ResizeObserver, so all three are stood in for. The field and
// box C sit at fixed places on the page, and the observer reports as soon as it starts watching.
const installBrowserStubs = (prefersReducedMotion: boolean) => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? prefersReducedMotion : false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly onResize: ResizeObserverCallback) {}
      observe() {
        this.onResize([], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute("data-hero-clearing")) {
      return rectOf({
        left: FIELD_LEFT_PX + CLEARING_BOX.left,
        top: FIELD_TOP_PX + CLEARING_BOX.top,
        right: FIELD_LEFT_PX + CLEARING_BOX.right,
        bottom: FIELD_TOP_PX + CLEARING_BOX.bottom,
      }) as DOMRect;
    }
    return rectOf({
      left: FIELD_LEFT_PX,
      top: FIELD_TOP_PX,
      right: FIELD_LEFT_PX + FIELD_WIDTH_PX,
      bottom: FIELD_TOP_PX + FIELD_HEIGHT_PX,
    }) as DOMRect;
  });
};

const renderFieldBesideClearing = (layoutSeed: number) =>
  render(
    <div>
      <MemphisHeroArt layoutSeed={layoutSeed} />
      <div data-hero-clearing />
    </div>,
  );

const cellSpan = (tile: HTMLElement) => {
  const column = /span (\d+)/.exec(tile.style.gridColumn)?.[1] ?? "1";
  const row = /span (\d+)/.exec(tile.style.gridRow)?.[1] ?? "1";
  return Number(column) * Number(row);
};

const readFilledShare = (container: HTMLElement) => {
  const tiles = [...container.querySelectorAll<HTMLElement>(".home-memphis-tile")];
  let totalArea = 0;
  let filledArea = 0;
  for (const tile of tiles) {
    const area = cellSpan(tile);
    totalArea += area;
    const fill = tile.querySelector(".home-memphis-fill");
    if (fill?.getAttribute("data-active") === "true") filledArea += area;
  }
  return filledArea / totalArea;
};

const readCoveredUnitIndexes = (container: HTMLElement) => {
  const covered: number[] = [];
  for (const tile of container.querySelectorAll<HTMLElement>(".home-memphis-tile")) {
    const [startColumn, columnSpan] =
      /(\d+) \/ span (\d+)/.exec(tile.style.gridColumn)?.slice(1) ?? [];
    const [startRow, rowSpan] = /(\d+) \/ span (\d+)/.exec(tile.style.gridRow)?.slice(1) ?? [];
    for (let dr = 0; dr < Number(rowSpan); dr += 1) {
      for (let dc = 0; dc < Number(columnSpan); dc += 1) {
        covered.push(unitIndex(Number(startColumn) - 1 + dc, Number(startRow) - 1 + dr));
      }
    }
  }
  return covered;
};

describe("findGridUnitsOutsideClearing", () => {
  const outside = findGridUnitsOutsideClearing({
    columns: COLUMNS,
    rows: ROWS,
    cellSize: { width: CELL_PX, height: CELL_PX },
    clearing: CLEARING_BOX,
  });

  it("reports a unit inside the zone as not outside", () => {
    expect(outside[unitIndex(10, 6)]).toBe(false);
    expect(outside[unitIndex(5, 4)]).toBe(false);
  });

  it("reports the units above and below the zone, and in the far corners, as outside", () => {
    expect(outside[unitIndex(10, 0)]).toBe(true);
    expect(outside[unitIndex(0, 0)]).toBe(true);
    expect(outside[unitIndex(10, 11)]).toBe(true);
    expect(outside[unitIndex(19, 11)]).toBe(true);
  });

  it("reaches 48px beyond the box at its top edge and 168px at its vertical middle", () => {
    expect(outside[unitIndex(10, 3)]).toBe(false);
    expect(outside[unitIndex(10, 2)]).toBe(true);
    expect(outside[unitIndex(1, 5)]).toBe(false);
    expect(outside[unitIndex(0, 5)]).toBe(true);
    expect(outside[unitIndex(18, 5)]).toBe(false);
    expect(outside[unitIndex(19, 5)]).toBe(true);
  });

  it("steps in toward the box above its corners and out toward its middle", () => {
    expect(outside[unitIndex(2, 3)]).toBe(true);
    expect(outside[unitIndex(3, 3)]).toBe(false);
    expect(outside[unitIndex(2, 5)]).toBe(false);
    expect(outside[unitIndex(1, 6)]).toBe(false);
  });
});

describe("MemphisHeroArt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sizes its grid from the measured field, in cells of about 60px", () => {
    installBrowserStubs(false);

    const { container } = renderFieldBesideClearing(1);

    const grid = container.querySelector<HTMLElement>(".home-memphis-grid");
    expect(grid?.style.gridTemplateColumns).toBe(`repeat(${COLUMNS}, minmax(0, 1fr))`);
    expect(grid?.style.gridTemplateRows).toBe(`repeat(${ROWS}, minmax(0, 1fr))`);
  });

  it("draws no tile of any shape over a unit inside the zone, now or after idle ticks", () => {
    installBrowserStubs(false);
    const outside = findGridUnitsOutsideClearing({
      columns: COLUMNS,
      rows: ROWS,
      cellSize: { width: CELL_PX, height: CELL_PX },
      clearing: CLEARING_BOX,
    });

    for (const seed of [1, 2, 3, 0x9e3779b1]) {
      const { container, unmount } = renderFieldBesideClearing(seed);
      for (let tick = 0; tick < 10; tick += 1) {
        act(() => {
          vi.advanceTimersByTime(BLINK_INTERVAL_MS);
        });
      }

      const covered = readCoveredUnitIndexes(container);
      expect(covered.length).toBeGreaterThan(0);
      for (const index of covered) {
        expect(outside[index], `seed ${seed} covers unit ${index}`).toBe(true);
      }
      unmount();
    }
  });

  it("keeps at least 80 percent of the cells outside the zone filled through every idle tick", () => {
    installBrowserStubs(false);
    const { container } = renderFieldBesideClearing(1);
    expect(readFilledShare(container)).toBeGreaterThanOrEqual(MIN_FILLED_SHARE);

    for (let tick = 0; tick < TICKS_TO_RUN; tick += 1) {
      act(() => {
        vi.advanceTimersByTime(BLINK_INTERVAL_MS);
      });
      expect(readFilledShare(container)).toBeGreaterThanOrEqual(MIN_FILLED_SHARE);
    }
  });

  it("shows every tile and moves none under reduced motion", () => {
    installBrowserStubs(true);

    const { container } = renderFieldBesideClearing(1);
    act(() => {
      vi.advanceTimersByTime(BLINK_INTERVAL_MS * 4);
    });

    expect(readFilledShare(container)).toBe(1);
  });

  it("gives two seeds two different layouts", () => {
    installBrowserStubs(true);

    const first = renderFieldBesideClearing(1);
    const second = renderFieldBesideClearing(2);

    const placementsOf = (container: HTMLElement) =>
      [...container.querySelectorAll<HTMLElement>(".home-memphis-tile")]
        .map((tile) => `${tile.style.gridColumn}|${tile.style.gridRow}`)
        .join(",");
    expect(placementsOf(first.container)).not.toBe(placementsOf(second.container));
  });
});
