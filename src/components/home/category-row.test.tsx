import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({ children, href, ...rest }: { children: unknown; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
  };
});

import { CategoryRow } from "@/components/home/category-row";

type PointerInit = { pointerType: "mouse" | "touch"; clientX: number; button?: number };

// jsdom has no PointerEvent, so a mouse event of the pointer type carries the pointer kind.
const firePointer = (target: Element | Window, type: string, init: PointerInit) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, "pointerType", { value: init.pointerType });
  fireEvent(target, event);
};

// Reports whether a click reached the document, where the page would have followed the link.
// The listener also cancels the click so jsdom does not try to navigate.
const watchClicksReachingDocument = () => {
  const watch = { reached: false };
  const onClick = (event: MouseEvent) => {
    watch.reached = true;
    event.preventDefault();
  };
  document.addEventListener("click", onClick);
  return { watch, stop: () => document.removeEventListener("click", onClick) };
};

const renderScrollableRow = () => {
  render(<CategoryRow />);
  const row = screen.getByRole("list");
  Object.defineProperty(row, "scrollWidth", { configurable: true, value: 2000 });
  Object.defineProperty(row, "clientWidth", { configurable: true, value: 600 });
  row.scrollLeft = 300;
  const tile = screen.getByRole("link", { name: "Debat" });
  return { row, tile };
};

const dragBy = (tile: HTMLElement, distance: number, pointerType: "mouse" | "touch" = "mouse") => {
  firePointer(tile, "pointerdown", { pointerType, clientX: 500 });
  firePointer(window, "pointermove", { pointerType, clientX: 500 + distance });
  firePointer(window, "pointerup", { pointerType, clientX: 500 + distance });
};

describe("CategoryRow drag", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scrolls the row with the mouse and swallows the click that follows the drag", () => {
    const { row, tile } = renderScrollableRow();
    const { watch, stop } = watchClicksReachingDocument();

    dragBy(tile, -120);
    const clickWasNotCancelled = fireEvent.click(tile);
    stop();

    expect(row.scrollLeft).toBe(420);
    expect(watch.reached).toBe(false);
    expect(clickWasNotCancelled).toBe(false);
  });

  it("does not start a drag with a button other than the primary one", () => {
    const { row, tile } = renderScrollableRow();
    const { watch, stop } = watchClicksReachingDocument();

    firePointer(tile, "pointerdown", { pointerType: "mouse", clientX: 500, button: 2 });
    firePointer(window, "pointermove", { pointerType: "mouse", clientX: 380 });
    firePointer(window, "pointerup", { pointerType: "mouse", clientX: 380 });
    fireEvent.click(tile);
    stop();

    expect(row.scrollLeft).toBe(300);
    expect(watch.reached).toBe(true);
  });

  it("stops following the pointer once the drag is released", () => {
    const { row, tile } = renderScrollableRow();

    dragBy(tile, -120);
    firePointer(window, "pointermove", { pointerType: "mouse", clientX: 200 });

    expect(row.scrollLeft).toBe(420);
  });

  it("lets a click through after a movement of 6px or less", () => {
    const { row, tile } = renderScrollableRow();
    const { watch, stop } = watchClicksReachingDocument();

    dragBy(tile, -6);
    fireEvent.click(tile);
    stop();

    expect(row.scrollLeft).toBe(300);
    expect(watch.reached).toBe(true);
  });

  it("lets a later click through when the drag was released with no click after it", () => {
    vi.useFakeTimers();
    const { tile } = renderScrollableRow();
    const { watch, stop } = watchClicksReachingDocument();

    dragBy(tile, 80);
    vi.runAllTimers();
    fireEvent.click(tile);
    stop();

    expect(watch.reached).toBe(true);
  });

  it("leaves touch to the browser's own scrolling", () => {
    const { row, tile } = renderScrollableRow();
    const { watch, stop } = watchClicksReachingDocument();

    dragBy(tile, -120, "touch");
    fireEvent.click(tile);
    stop();

    expect(row.scrollLeft).toBe(300);
    expect(watch.reached).toBe(true);
  });

  it("does not treat a drag as a drag when the row has nothing to scroll", () => {
    const { row, tile } = renderScrollableRow();
    Object.defineProperty(row, "scrollWidth", { configurable: true, value: 600 });
    const { watch, stop } = watchClicksReachingDocument();

    dragBy(tile, -120);
    fireEvent.click(tile);
    stop();

    expect(row.scrollLeft).toBe(300);
    expect(watch.reached).toBe(true);
  });
});
