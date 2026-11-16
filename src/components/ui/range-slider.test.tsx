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
      label="Ukuran tim"
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

  it("steps by 3 with Page Up and Page Down", () => {
    render(<Harness start={{ min: 2, max: 8 }} />);

    fireEvent.keyDown(minHandle(), { key: "PageUp" });
    expect(valueOf(minHandle())).toBe(5);
    fireEvent.keyDown(minHandle(), { key: "PageDown" });
    fireEvent.keyDown(minHandle(), { key: "PageDown" });
    expect(valueOf(minHandle())).toBe(1);

    fireEvent.keyDown(maxHandle(), { key: "PageUp" });
    expect(valueOf(maxHandle())).toBe(10);
  });

  it.each(["altKey", "metaKey", "ctrlKey"])(
    "leaves a key held with %s to the browser",
    (modifier) => {
      render(<Harness start={{ min: 3, max: 6 }} />);

      for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]) {
        const notPrevented = fireEvent.keyDown(minHandle(), { key, [modifier]: true });
        expect(notPrevented).toBe(true);
      }
      expect(valueOf(minHandle())).toBe(3);
    },
  );

  it("still moves with Shift held", () => {
    render(<Harness start={{ min: 3, max: 6 }} />);

    fireEvent.keyDown(minHandle(), { key: "ArrowRight", shiftKey: true });

    expect(valueOf(minHandle())).toBe(4);
  });

  it("names the group after the slider and describes it with the value text", () => {
    render(<Harness start={{ min: 2, max: 7 }} />);

    const group = screen.getByRole("group", { name: "Ukuran tim" });

    expect(group.contains(minHandle())).toBe(true);
    expect(group.contains(maxHandle())).toBe(true);
    const describedBy = group.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe("2 sampai 7");
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
        label="Ukuran tim"
        minHandleLabel="Ukuran tim minimum"
        maxHandleLabel="Ukuran tim maksimum"
        summary="1 sampai 10+"
        describeValue={(value) => (value === 10 ? "10 atau lebih" : String(value))}
      />,
    );

    expect(maxHandle().getAttribute("aria-valuetext")).toBe("10 atau lebih");
  });
});

function FeeHarness({ start }: { start: RangeSliderValue }) {
  const [value, setValue] = useState(start);
  return (
    <RangeSlider
      floor={0}
      ceiling={250_000}
      step={25_000}
      maxHandleLowest={25_000}
      value={value}
      onChange={setValue}
      label="Rentang biaya"
      minHandleLabel="Biaya minimum"
      maxHandleLabel="Biaya maksimum"
      summary={`${value.min} sampai ${value.max}`}
    />
  );
}

const feeMinHandle = () => screen.getByRole("slider", { name: "Biaya minimum" });
const feeMaxHandle = () => screen.getByRole("slider", { name: "Biaya maksimum" });

describe("RangeSlider maxHandleLowest", () => {
  it("keeps the max handle at its lowest value with the keys", () => {
    render(<FeeHarness start={{ min: 0, max: 50_000 }} />);

    fireEvent.keyDown(feeMaxHandle(), { key: "ArrowLeft" });
    expect(valueOf(feeMaxHandle())).toBe(25_000);
    fireEvent.keyDown(feeMaxHandle(), { key: "ArrowLeft" });
    fireEvent.keyDown(feeMaxHandle(), { key: "PageDown" });
    fireEvent.keyDown(feeMaxHandle(), { key: "Home" });

    expect(valueOf(feeMaxHandle())).toBe(25_000);
    expect(valueOf(feeMinHandle())).toBe(0);
  });

  it("tells a screen reader where the max handle can go", () => {
    render(<FeeHarness start={{ min: 0, max: 100_000 }} />);

    expect(feeMaxHandle().getAttribute("aria-valuemin")).toBe("25000");
    expect(feeMinHandle().getAttribute("aria-valuemin")).toBe("0");
  });

  it("still lets the min handle pass the lowest value of the max handle", () => {
    render(<FeeHarness start={{ min: 0, max: 100_000 }} />);

    fireEvent.keyDown(feeMinHandle(), { key: "End" });

    expect(valueOf(feeMinHandle())).toBe(100_000);
  });

  it("stops a pointer drag of the max handle at its lowest value", () => {
    render(<FeeHarness start={{ min: 0, max: 100_000 }} />);
    const track = document.querySelector<HTMLElement>(".range-slider-track")!;
    track.getBoundingClientRect = () =>
      ({ left: 0, right: 100, width: 100, top: 0, bottom: 10, height: 10, x: 0, y: 0 }) as DOMRect;

    press(feeMaxHandle(), 40);
    moveTo(track, 0);

    expect(valueOf(feeMaxHandle())).toBe(25_000);
  });

  it("does not move the max handle below the min handle when the lowest value is lower", () => {
    render(<FeeHarness start={{ min: 150_000, max: 200_000 }} />);

    fireEvent.keyDown(feeMaxHandle(), { key: "Home" });

    expect(valueOf(feeMaxHandle())).toBe(150_000);
  });

  it("leaves the team size slider's limits as they were", () => {
    render(<Harness start={{ min: 1, max: 5 }} />);

    expect(maxHandle().getAttribute("aria-valuemin")).toBe("1");
    fireEvent.keyDown(maxHandle(), { key: "Home" });
    expect(valueOf(maxHandle())).toBe(1);
  });
});

// jsdom has no layout, so the track is given a width of 90: on a 1 to 10 track a press at x lands
// on 1 + round(x / 10).
const stubTrackWidthOf90 = () => {
  const track = document.querySelector<HTMLElement>(".range-slider-track")!;
  track.getBoundingClientRect = () =>
    ({ left: 0, right: 90, width: 90, top: 0, bottom: 10, height: 10, x: 0, y: 0 }) as DOMRect;
  return track;
};

// jsdom has no PointerEvent, and fireEvent.pointerDown would fall back to a plain Event that loses
// clientX and button. A MouseEvent with a pointer type name carries both and React reads it as a
// pointer event.
const firePointer = (
  target: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  button = 0,
) => fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button }));

const press = (target: HTMLElement, clientX: number, button = 0) =>
  firePointer(target, "pointerdown", clientX, button);

const moveTo = (target: HTMLElement, clientX: number) =>
  firePointer(target, "pointermove", clientX);

const release = (target: HTMLElement) => firePointer(target, "pointerup", 0);

describe("RangeSlider pointer", () => {
  it("moves the nearer handle when the track is pressed", () => {
    render(<Harness start={{ min: 2, max: 8 }} />);
    const track = stubTrackWidthOf90();

    press(track, 20);
    expect(valueOf(minHandle())).toBe(3);

    press(track, 70);
    expect(valueOf(maxHandle())).toBe(8);
    press(track, 60);
    expect(valueOf(maxHandle())).toBe(7);
  });

  it("carries a handle along with the drag and stops when the pointer is released", () => {
    render(<Harness start={{ min: 2, max: 8 }} />);
    const track = stubTrackWidthOf90();

    press(maxHandle(), 70);
    moveTo(track, 40);
    expect(valueOf(maxHandle())).toBe(5);
    release(track);
    moveTo(track, 90);

    expect(valueOf(maxHandle())).toBe(5);
    expect(valueOf(minHandle())).toBe(2);
  });

  it("does nothing for a press with any button but the primary one", () => {
    render(<Harness start={{ min: 2, max: 8 }} />);
    const track = stubTrackWidthOf90();

    press(track, 50, 2);
    moveTo(track, 80);

    expect(valueOf(minHandle())).toBe(2);
    expect(valueOf(maxHandle())).toBe(8);
  });

  describe("two handles on one value", () => {
    it("lets the first move to the left take the lower handle", () => {
      render(<Harness start={{ min: 5, max: 5 }} />);
      const track = stubTrackWidthOf90();

      press(maxHandle(), 40);
      expect(valueOf(minHandle())).toBe(5);
      expect(valueOf(maxHandle())).toBe(5);
      moveTo(track, 20);

      expect(valueOf(minHandle())).toBe(3);
      expect(valueOf(maxHandle())).toBe(5);
    });

    it("lets the first move to the right take the upper handle", () => {
      render(<Harness start={{ min: 5, max: 5 }} />);
      const track = stubTrackWidthOf90();

      press(minHandle(), 40);
      moveTo(track, 70);

      expect(valueOf(minHandle())).toBe(5);
      expect(valueOf(maxHandle())).toBe(8);
    });

    it("takes the upper handle at the start of the track, where the lower one cannot move", () => {
      render(<Harness start={{ min: 1, max: 1 }} />);
      const track = stubTrackWidthOf90();

      press(maxHandle(), 0);
      moveTo(track, 50);

      expect(valueOf(minHandle())).toBe(1);
      expect(valueOf(maxHandle())).toBe(6);
    });

    it("takes the lower handle at the end of the track, where the upper one cannot move", () => {
      render(<Harness start={{ min: 10, max: 10 }} />);
      const track = stubTrackWidthOf90();

      press(minHandle(), 90);
      moveTo(track, 60);

      expect(valueOf(minHandle())).toBe(7);
      expect(valueOf(maxHandle())).toBe(10);
    });
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
