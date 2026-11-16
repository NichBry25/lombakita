"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export type RangeSliderValue = { min: number; max: number };

type HandleName = "min" | "max";

type RangeSliderProps = {
  // The two ends of the track.
  floor: number;
  ceiling: number;
  step?: number;
  value: RangeSliderValue;
  onChange: (value: RangeSliderValue) => void;
  minHandleLabel: string;
  maxHandleLabel: string;
  // The range in words, shown above the track.
  summary: string;
  // Turns a handle's number into the words a screen reader announces for it.
  describeValue?: (value: number) => string;
};

const clamp = (value: number, lowest: number, highest: number): number =>
  Math.min(highest, Math.max(lowest, value));

// A handle moves between its track end and the other handle, so the two never cross.
const limitsFor = (handle: HandleName, value: RangeSliderValue, floor: number, ceiling: number) =>
  handle === "min"
    ? { lowest: floor, highest: value.max }
    : { lowest: value.min, highest: ceiling };

export const moveHandle = (
  value: RangeSliderValue,
  handle: HandleName,
  target: number,
  floor: number,
  ceiling: number,
): RangeSliderValue => {
  const { lowest, highest } = limitsFor(handle, value, floor, ceiling);
  const moved = clamp(target, lowest, highest);
  return handle === "min" ? { min: moved, max: value.max } : { min: value.min, max: moved };
};

const KEYBOARD_STEP_DIRECTION: Record<string, number> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
};

// The number a key asks a handle to move to, or undefined for a key the slider does not use.
export const targetForKey = (
  key: string,
  handle: HandleName,
  value: RangeSliderValue,
  floor: number,
  ceiling: number,
  step: number,
): number | undefined => {
  const { lowest, highest } = limitsFor(handle, value, floor, ceiling);
  const current = value[handle];
  if (key === "Home") return lowest;
  if (key === "End") return highest;
  const direction = KEYBOARD_STEP_DIRECTION[key];
  return direction === undefined ? undefined : current + direction * step;
};

const percentOf = (value: number, floor: number, ceiling: number): number =>
  ((value - floor) / (ceiling - floor)) * 100;

/**
 * Two round handles on one track that pick a range. The handles are role="slider" elements with
 * their own names, arrow keys step them, Home and End jump to the nearest limit, and neither can
 * pass the other. A press on the track moves the nearer handle and a drag carries it.
 */
export function RangeSlider({
  floor,
  ceiling,
  step = 1,
  value,
  onChange,
  minHandleLabel,
  maxHandleLabel,
  summary,
  describeValue = String,
}: RangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  // "undecided" is a press on two handles that share one value: the first move says which to drag.
  const draggedHandleRef = useRef<HandleName | "undecided" | null>(null);
  const minHandleRef = useRef<HTMLDivElement>(null);
  const maxHandleRef = useRef<HTMLDivElement>(null);

  const valueAtPointer = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return value.min;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    const steps = Math.round((ceiling - floor) / step);
    return floor + Math.round(ratio * steps) * step;
  };

  const nearerHandle = (pointerValue: number): HandleName => {
    if (pointerValue >= value.max) return "max";
    if (pointerValue <= value.min) return "min";
    return pointerValue - value.min < value.max - pointerValue ? "min" : "max";
  };

  const grabbedHandleName = (target: EventTarget): HandleName | undefined => {
    const grabbed = (target as HTMLElement).closest<HTMLElement>("[data-handle]");
    const name = grabbed?.dataset.handle;
    return name === "min" || name === "max" ? name : undefined;
  };

  // Two handles on one value: the top one would trap the drag, so at a track end the handle that
  // can still move is the one taken, and anywhere else the first move decides.
  const handleToDragWhenStacked = (): HandleName | "undecided" => {
    if (value.min === floor) return "max";
    if (value.max === ceiling) return "min";
    return "undecided";
  };

  const pickHandleToDrag = (target: EventTarget, pointerValue: number) => {
    const grabbed = grabbedHandleName(target);
    if (!grabbed) return nearerHandle(pointerValue);
    return value.min === value.max ? handleToDragWhenStacked() : grabbed;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const pointerValue = valueAtPointer(event.clientX);
    const handle = pickHandleToDrag(event.target, pointerValue);
    draggedHandleRef.current = handle;
    trackRef.current?.setPointerCapture?.(event.pointerId);
    if (handle === "undecided") return;
    const handleElement = handle === "min" ? minHandleRef.current : maxHandleRef.current;
    handleElement?.focus();
    onChange(moveHandle(value, handle, pointerValue, floor, ceiling));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pointerValue = valueAtPointer(event.clientX);
    let handle = draggedHandleRef.current;
    if (handle === "undecided") {
      if (pointerValue === value.min) return;
      handle = pointerValue < value.min ? "min" : "max";
      draggedHandleRef.current = handle;
    }
    if (!handle) return;
    onChange(moveHandle(value, handle, pointerValue, floor, ceiling));
  };

  const stopDragging = () => {
    draggedHandleRef.current = null;
  };

  const onHandleKeyDown = (handle: HandleName) => (event: KeyboardEvent<HTMLDivElement>) => {
    const target = targetForKey(event.key, handle, value, floor, ceiling, step);
    if (target === undefined) return;
    event.preventDefault();
    onChange(moveHandle(value, handle, target, floor, ceiling));
  };

  const minPercent = percentOf(value.min, floor, ceiling);
  const maxPercent = percentOf(value.max, floor, ceiling);

  const renderHandle = (handle: HandleName, label: string) => {
    const { lowest, highest } = limitsFor(handle, value, floor, ceiling);
    const current = value[handle];
    return (
      <div
        ref={handle === "min" ? minHandleRef : maxHandleRef}
        role="slider"
        tabIndex={0}
        data-handle={handle}
        className="range-slider-handle"
        style={{ insetInlineStart: `${handle === "min" ? minPercent : maxPercent}%` }}
        aria-label={label}
        aria-orientation="horizontal"
        aria-valuemin={lowest}
        aria-valuemax={highest}
        aria-valuenow={current}
        aria-valuetext={describeValue(current)}
        onKeyDown={onHandleKeyDown(handle)}
      />
    );
  };

  return (
    <div className="range-slider">
      <p className="range-slider-summary">{summary}</p>
      <div
        ref={trackRef}
        className="range-slider-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      >
        <div className="range-slider-rail" aria-hidden="true" />
        <div
          className="range-slider-fill"
          aria-hidden="true"
          style={{
            insetInlineStart: `${minPercent}%`,
            inlineSize: `${maxPercent - minPercent}%`,
          }}
        />
        {renderHandle("min", minHandleLabel)}
        {renderHandle("max", maxHandleLabel)}
      </div>
    </div>
  );
}
