"use client";

import { useId, useRef, type KeyboardEvent, type PointerEvent } from "react";

export type RangeSliderValue = { min: number; max: number };

type HandleName = "min" | "max";

type RangeSliderProps = {
  // The two ends of the track.
  floor: number;
  ceiling: number;
  step?: number;
  // The lowest value the max handle can take, for a track whose upper end must stay above its start.
  // Without it the max handle can go down to the min handle.
  maxHandleLowest?: number;
  value: RangeSliderValue;
  onChange: (value: RangeSliderValue) => void;
  // Names the group the two handles sit in.
  label: string;
  minHandleLabel: string;
  maxHandleLabel: string;
  // The range in words, shown above the track and read as the group's description.
  summary: string;
  // Turns a handle's number into the words a screen reader announces for it.
  describeValue?: (value: number) => string;
};

const clamp = (value: number, lowest: number, highest: number): number =>
  Math.min(highest, Math.max(lowest, value));

// A handle moves between its track end and the other handle, so the two never cross. The max
// handle also stops at `maxHandleLowest` when a caller sets one.
const limitsFor = (
  handle: HandleName,
  value: RangeSliderValue,
  floor: number,
  ceiling: number,
  maxHandleLowest = floor,
) =>
  handle === "min"
    ? { lowest: floor, highest: value.max }
    : { lowest: Math.max(value.min, maxHandleLowest), highest: ceiling };

export const moveHandle = (
  value: RangeSliderValue,
  handle: HandleName,
  target: number,
  floor: number,
  ceiling: number,
  maxHandleLowest?: number,
): RangeSliderValue => {
  const { lowest, highest } = limitsFor(handle, value, floor, ceiling, maxHandleLowest);
  const moved = clamp(target, lowest, highest);
  return handle === "min" ? { min: moved, max: value.max } : { min: value.min, max: moved };
};

// How many steps a key moves a handle: arrows one, Page Up and Page Down three.
const KEYBOARD_STEP_COUNT: Record<string, number> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
  PageUp: 3,
  PageDown: -3,
};

// The number a key asks a handle to move to, or undefined for a key the slider does not use.
export const targetForKey = (
  key: string,
  handle: HandleName,
  value: RangeSliderValue,
  floor: number,
  ceiling: number,
  step: number,
  maxHandleLowest?: number,
): number | undefined => {
  const { lowest, highest } = limitsFor(handle, value, floor, ceiling, maxHandleLowest);
  const current = value[handle];
  if (key === "Home") return lowest;
  if (key === "End") return highest;
  const stepCount = KEYBOARD_STEP_COUNT[key];
  return stepCount === undefined ? undefined : current + stepCount * step;
};

// A key held with Alt, Meta or Ctrl belongs to the browser or the system, such as Alt+Left to go back.
const hasShortcutModifier = (event: KeyboardEvent): boolean =>
  event.altKey || event.metaKey || event.ctrlKey;

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
  maxHandleLowest,
  value,
  onChange,
  label,
  minHandleLabel,
  maxHandleLabel,
  summary,
  describeValue = String,
}: RangeSliderProps) {
  const summaryId = useId();
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
    const isPrimaryButton = event.button === 0;
    if (!isPrimaryButton) return;
    const pointerValue = valueAtPointer(event.clientX);
    const handle = pickHandleToDrag(event.target, pointerValue);
    draggedHandleRef.current = handle;
    trackRef.current?.setPointerCapture?.(event.pointerId);
    if (handle === "undecided") return;
    const handleElement = handle === "min" ? minHandleRef.current : maxHandleRef.current;
    handleElement?.focus();
    onChange(moveHandle(value, handle, pointerValue, floor, ceiling, maxHandleLowest));
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
    onChange(moveHandle(value, handle, pointerValue, floor, ceiling, maxHandleLowest));
  };

  const stopDragging = () => {
    draggedHandleRef.current = null;
  };

  const onHandleKeyDown = (handle: HandleName) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (hasShortcutModifier(event)) return;
    const target = targetForKey(event.key, handle, value, floor, ceiling, step, maxHandleLowest);
    if (target === undefined) return;
    event.preventDefault();
    onChange(moveHandle(value, handle, target, floor, ceiling, maxHandleLowest));
  };

  const minPercent = percentOf(value.min, floor, ceiling);
  const maxPercent = percentOf(value.max, floor, ceiling);

  const renderHandle = (handle: HandleName, label: string) => {
    const { lowest, highest } = limitsFor(handle, value, floor, ceiling, maxHandleLowest);
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
    <div className="range-slider" role="group" aria-label={label} aria-describedby={summaryId}>
      <p id={summaryId} className="range-slider-summary">
        {summary}
      </p>
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
