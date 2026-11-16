"use client";

import { useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

const DRAG_THRESHOLD_PX = 6;

type DragStart = { pointerX: number; scrollLeft: number; moved: boolean };

/*
 * Lets a mouse drag a sideways-scrolling row. Touch and trackpads scroll it natively, so only
 * mouse pointers are handled here. A drag longer than DRAG_THRESHOLD_PX swallows the click the
 * browser fires on release, so letting go over a link does not open it.
 */
export function useDragScroll<T extends HTMLElement>() {
  const rowRef = useRef<T>(null);
  const swallowNextClickRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  function startDrag(event: ReactPointerEvent<T>) {
    const row = rowRef.current;
    if (!row) return;
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if (row.scrollWidth <= row.clientWidth) return;

    const scrollableRow: T = row;
    const drag: DragStart = {
      pointerX: event.clientX,
      scrollLeft: scrollableRow.scrollLeft,
      moved: false,
    };

    function followPointer(moveEvent: PointerEvent) {
      const distance = moveEvent.clientX - drag.pointerX;
      if (!drag.moved && Math.abs(distance) <= DRAG_THRESHOLD_PX) return;
      if (!drag.moved) setIsDragging(true);
      drag.moved = true;
      scrollableRow.scrollLeft = drag.scrollLeft - distance;
    }

    function endDrag() {
      window.removeEventListener("pointermove", followPointer);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      setIsDragging(false);
      if (!drag.moved) return;
      swallowNextClickRef.current = true;
      // The click, if any, fires right after pointerup; a release off the row fires none.
      window.setTimeout(() => {
        swallowNextClickRef.current = false;
      }, 0);
    }

    window.addEventListener("pointermove", followPointer);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  }

  function swallowClickAfterDrag(event: ReactMouseEvent<T>) {
    if (!swallowNextClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }

  return { rowRef, isDragging, startDrag, swallowClickAfterDrag };
}
