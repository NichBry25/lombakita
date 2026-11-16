// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RangeSlider, moveHandle, targetForKey, type RangeSliderValue } from "./range-slider";

afterEach(cleanup);

function Harness({ start }: { start: RangeSliderValue }) {
  const [value, setValue] = useState(start);
  return (
    <RangeSlider
      floor={1}
      ceiling={10}
      value={value}
      onChange={setValue}
      minHandleLabel="Ukuran tim minimum"
      maxHandleLabel="Ukuran tim maksimum"
      summary={`${value.min} sampai ${value.max}`}
    />
  );
}

const minHandle = () => screen.getByRole("slider", { name: "Ukuran tim minimum" });
const maxHandle = () => screen.getByRole("slider", { name: "Ukuran tim maksimum" });
const valueOf = (handle: HTMLElement) => Number(handle.getAttribute("aria-valuenow"));

describe("RangeSlider handles", () => {
  it("gives each handle its own name and its current value", () => {
    render(<Harness start={{ min: 2, max: 7 }} />);

    expect(valueOf(minHandle())).toBe(2);
    expect(valueOf(maxHandle())).toBe(7);
    expect(screen.getByText("2 sampai 7")).toBeTruthy();
  });

  it("limits each handle by the other, so the limits tell a screen reader where it can go", () => {
    render(<Harness start={{ min: 2, max: 7 }} />);

    expect(minHandle().getAttribute("aria-valuemin")).toBe("1");
    expect(minHandle().getAttribute("aria-valuemax")).toBe("7");
    expect(maxHandle().getAttribute("aria-valuemin")).toBe("2");
    expect(maxHandle().getAttribute("aria-valuemax")).toBe("10");
  });

  it("steps by 1 with the arrow keys", () => {
    render(<Harness start={{ min: 3, max: 6 }} />);

    fireEvent.keyDown(minHandle(), { key: "ArrowRight" });
    expect(valueOf(minHandle())).toBe(4);
    fireEvent.keyDown(minHandle(), { key: "ArrowUp" });
    expect(valueOf(minHandle())).toBe(5);
    fireEvent.keyDown(minHandle(), { key: "ArrowLeft" });
    fireEvent.keyDown(minHandle(), { key: "ArrowDown" });
    expect(valueOf(minHandle())).toBe(3);

    fireEvent.keyDown(maxHandle(), { key: "ArrowRight" });
    expect(valueOf(maxHandle())).toBe(7);
  });

  it("jumps to its limit with Home and End", () => {
    render(<Harness start={{ min: 3, max: 6 }} />);

    fireEvent.keyDown(minHandle(), { key: "Home" });
    expect(valueOf(minHandle())).toBe(1);
    fireEvent.keyDown(minHandle(), { key: "End" });
    expect(valueOf(minHandle())).toBe(6);

    fireEvent.keyDown(maxHandle(), { key: "End" });
    expect(valueOf(maxHandle())).toBe(10);
    fireEvent.keyDown(maxHandle(), { key: "Home" });
    expect(valueOf(maxHandle())).toBe(6);
  });

  it("never lets the handles cross", () => {
    render(<Harness start={{ min: 4, max: 5 }} />);

    fireEvent.keyDown(minHandle(), { key: "ArrowRight" });
    fireEvent.keyDown(minHandle(), { key: "ArrowRight" });
    expect(valueOf(minHandle())).toBe(5);
    expect(valueOf(maxHandle())).toBe(5);

    fireEvent.keyDown(maxHandle(), { key: "ArrowLeft" });
    expect(valueOf(maxHandle())).toBe(5);
  });

  it("stops at the ends of the track", () => {
    render(<Harness start={{ min: 1, max: 10 }} />);

    fireEvent.keyDown(minHandle(), { key: "ArrowLeft" });
    fireEvent.keyDown(maxHandle(), { key: "ArrowRight" });

    expect(valueOf(minHandle())).toBe(1);
    expect(valueOf(maxHandle())).toBe(10);
  });

  it("leaves other keys alone", () => {
    render(<Harness start={{ min: 3, max: 6 }} />);

    const notPrevented = fireEvent.keyDown(minHandle(), { key: "a" });

    expect(notPrevented).toBe(true);
    expect(valueOf(minHandle())).toBe(3);
  });

  it("can be reached with Tab", () => {
    render(<Harness start={{ min: 3, max: 6 }} />);

    expect(minHandle().getAttribute("tabindex")).toBe("0");
    expect(maxHandle().getAttribute("tabindex")).toBe("0");
  });

  it("announces the words a caller gives for a value", () => {
    render(
      <RangeSlider
        floor={1}
        ceiling={10}
        value={{ min: 1, max: 10 }}
        onChange={() => undefined}
        minHandleLabel="Ukuran tim minimum"
        maxHandleLabel="Ukuran tim maksimum"
        summary="1 sampai 10+"
        describeValue={(value) => (value === 10 ? "10 atau lebih" : String(value))}
      />,
    );

    expect(maxHandle().getAttribute("aria-valuetext")).toBe("10 atau lebih");
  });
});

describe("RangeSlider rules", () => {
  it("clamps a moved handle between its track end and the other handle", () => {
    const value = { min: 3, max: 6 };

    expect(moveHandle(value, "min", 9, 1, 10)).toEqual({ min: 6, max: 6 });
    expect(moveHandle(value, "min", -4, 1, 10)).toEqual({ min: 1, max: 6 });
    expect(moveHandle(value, "max", 1, 1, 10)).toEqual({ min: 3, max: 3 });
    expect(moveHandle(value, "max", 40, 1, 10)).toEqual({ min: 3, max: 10 });
  });

  it("answers only the keys it uses", () => {
    const value = { min: 3, max: 6 };

    expect(targetForKey("ArrowRight", "min", value, 1, 10, 1)).toBe(4);
    expect(targetForKey("Home", "max", value, 1, 10, 1)).toBe(3);
    expect(targetForKey("End", "min", value, 1, 10, 1)).toBe(6);
    expect(targetForKey("Enter", "min", value, 1, 10, 1)).toBeUndefined();
  });
});
