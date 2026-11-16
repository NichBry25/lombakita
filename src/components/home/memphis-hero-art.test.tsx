import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemphisHeroArt } from "@/components/home/memphis-hero-art";

const PANEL_WIDTH_PX = 360;
const PANEL_HEIGHT_PX = 480;
const MIN_FILLED_SHARE = 0.8;
const TICKS_TO_RUN = 60;
const BLINK_INTERVAL_MS = 500;

// jsdom has neither matchMedia nor ResizeObserver, so both are stood in for. The observer reports
// a fixed panel size as soon as it starts watching.
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
        const contentRect = { width: PANEL_WIDTH_PX, height: PANEL_HEIGHT_PX };
        this.onResize([{ contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
};

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

describe("MemphisHeroArt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sizes its grid from the measured panel, in cells of about 60px", () => {
    installBrowserStubs(false);

    const { container } = render(<MemphisHeroArt layoutSeed={1} />);

    const grid = container.querySelector<HTMLElement>(".home-memphis-grid");
    expect(grid?.style.gridTemplateColumns).toBe("repeat(6, minmax(0, 1fr))");
    expect(grid?.style.gridTemplateRows).toBe("repeat(8, minmax(0, 1fr))");
  });

  it("keeps at least 80 percent of the cells filled through every idle tick", () => {
    installBrowserStubs(false);
    const { container } = render(<MemphisHeroArt layoutSeed={1} />);
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

    const { container } = render(<MemphisHeroArt layoutSeed={1} />);
    act(() => {
      vi.advanceTimersByTime(BLINK_INTERVAL_MS * 4);
    });

    expect(readFilledShare(container)).toBe(1);
  });

  it("gives two seeds two different layouts", () => {
    installBrowserStubs(true);

    const first = render(<MemphisHeroArt layoutSeed={1} />);
    const second = render(<MemphisHeroArt layoutSeed={2} />);

    const placementsOf = (container: HTMLElement) =>
      [...container.querySelectorAll<HTMLElement>(".home-memphis-tile")]
        .map((tile) => `${tile.style.gridColumn}|${tile.style.gridRow}`)
        .join(",");
    expect(placementsOf(first.container)).not.toBe(placementsOf(second.container));
  });
});
