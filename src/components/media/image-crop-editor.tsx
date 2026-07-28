"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CROPPED_IMAGE_MIME_TYPE,
  CROPPED_IMAGE_QUALITY,
  type ImageFrame,
} from "@/lib/media/image-frames";

const MAX_ZOOM = 3;
const KEYBOARD_PAN_STEP = 8;
const KEYBOARD_PAN_STEP_LARGE = 32;

export type ImageCropApi = { getCropped: () => Promise<File | null> };

type Offset = { x: number; y: number };

// A pan + zoom cropper rendered inside the shared modal. The image is sized to cover the frame at
// zoom 1; the user drags to reposition and uses the slider to zoom. The parent reads the result
// through `apiRef.current.getCropped()` (wired to the modal's save action) so no crop state has to
// leak back up.
//
// The viewport is measured rather than fixed because the frame ratio varies: a 4:1 banner at a
// usable height would be wider than the modal, so the element takes the width it is given and the
// crop math follows the measurement.
export function ImageCropEditor({
  src,
  fileName,
  frame,
  apiRef,
  shape = "blob",
  zoomLabel = "Perbesar",
  panLabel = "Area pemotongan gambar",
  hint = "Seret gambar, atau gunakan tombol panah, untuk menyesuaikan posisi.",
}: {
  src: string;
  fileName: string;
  frame: ImageFrame;
  apiRef: { current: ImageCropApi | null };
  // Corner treatment of the crop window. `blob` matches the organic avatar mask; `rect` is the
  // squared-off frame a wide banner reads as.
  shape?: "blob" | "rect";
  zoomLabel?: string;
  // Accessible name of the crop window itself, which is focusable so it can be panned by keyboard.
  panLabel?: string;
  hint?: string;
}) {
  const hintId = useId();
  const imgRef = useRef<HTMLImageElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });

  const viewportHeight = viewportWidth / frame.aspectRatio;

  // Smallest scale at which the image still covers the frame in both axes.
  const coverScale = useCallback(
    (w: number, h: number, vw: number, vh: number) => Math.max(vw / w, vh / h),
    [],
  );

  const baseScale = natural ? coverScale(natural.w, natural.h, viewportWidth, viewportHeight) : 1;
  const dispW = natural ? natural.w * baseScale * scale : viewportWidth;
  const dispH = natural ? natural.h * baseScale * scale : viewportHeight;

  // Keep the image covering the frame — never expose an empty edge.
  const clampOffset = useCallback(
    (o: Offset, w: number, h: number): Offset => ({
      x: Math.min(0, Math.max(viewportWidth - w, o.x)),
      y: Math.min(0, Math.max(viewportHeight - h, o.y)),
    }),
    [viewportWidth, viewportHeight],
  );

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setViewportWidth(width);
    });
    observer.observe(el);
    setViewportWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const centre = useCallback(
    (w: number, h: number, vw: number, vh: number) => {
      const bs = coverScale(w, h, vw, vh);
      return { x: (vw - w * bs) / 2, y: (vh - h * bs) / 2 };
    },
    [coverScale],
  );

  const onLoad = () => {
    const el = imgRef.current;
    if (!el || viewportWidth === 0) return;
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    setNatural({ w, h });
    setScale(1);
    setOffset(centre(w, h, viewportWidth, viewportHeight));
  };

  // Two cases the load handler cannot cover on its own: the image finishing before the viewport has
  // been measured (onLoad bails at width 0), and the viewport changing width afterwards on a window
  // resize. First framing centres the image; a later resize only re-clamps, so an in-progress crop
  // keeps its zoom and position.
  useEffect(() => {
    const el = imgRef.current;
    if (!el || viewportWidth === 0 || !el.complete || el.naturalWidth === 0) return;
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    const vh = viewportWidth / frame.aspectRatio;

    if (!natural) {
      setNatural({ w, h });
      setScale(1);
      setOffset(centre(w, h, viewportWidth, vh));
      return;
    }

    const factor = coverScale(w, h, viewportWidth, vh) * scale;
    setOffset((current) => ({
      x: Math.min(0, Math.max(viewportWidth - w * factor, current.x)),
      y: Math.min(0, Math.max(vh - h * factor, current.y)),
    }));
    // `scale` and `offset` are deliberately not dependencies: this runs on a frame-size change, not
    // on every user zoom or drag (those already clamp themselves).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportWidth, frame.aspectRatio, centre, coverScale, natural]);

  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = {
      x: drag.current.ox + (e.clientX - drag.current.x),
      y: drag.current.oy + (e.clientY - drag.current.y),
    };
    setOffset(clampOffset(next, dispW, dispH));
  };

  const endDrag = () => {
    drag.current = null;
  };

  // Panning by pointer alone would leave a keyboard user with only the auto-centred crop. Arrow
  // keys move the image by the same clamped rules the drag path uses.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEYBOARD_PAN_STEP_LARGE : KEYBOARD_PAN_STEP;
    const delta =
      e.key === "ArrowLeft"
        ? { x: -step, y: 0 }
        : e.key === "ArrowRight"
          ? { x: step, y: 0 }
          : e.key === "ArrowUp"
            ? { x: 0, y: -step }
            : e.key === "ArrowDown"
              ? { x: 0, y: step }
              : null;
    if (!delta) return;
    e.preventDefault();
    setOffset((current) =>
      clampOffset({ x: current.x + delta.x, y: current.y + delta.y }, dispW, dispH),
    );
  };

  const onZoom = (z: number) => {
    if (!natural) {
      setScale(z);
      return;
    }
    // Zoom around the frame centre so the framed subject stays put.
    const fx = (viewportWidth / 2 - offset.x) / dispW;
    const fy = (viewportHeight / 2 - offset.y) / dispH;
    const newW = natural.w * baseScale * z;
    const newH = natural.h * baseScale * z;
    setScale(z);
    setOffset(
      clampOffset(
        { x: viewportWidth / 2 - fx * newW, y: viewportHeight / 2 - fy * newH },
        newW,
        newH,
      ),
    );
  };

  // Latest crop state for the imperative getCropped (which is created once). Mirrored via an
  // effect rather than assigned during render (refs must not be written while rendering).
  const stateRef = useRef({ natural, baseScale, scale, offset, viewportWidth, viewportHeight });
  useEffect(() => {
    stateRef.current = { natural, baseScale, scale, offset, viewportWidth, viewportHeight };
  });

  useEffect(() => {
    apiRef.current = {
      getCropped: async () => {
        const el = imgRef.current;
        const s = stateRef.current;
        if (!el || !s.natural || s.viewportWidth === 0) return null;
        const factor = s.baseScale * s.scale;
        const sx = -s.offset.x / factor;
        const sy = -s.offset.y / factor;
        const sWidth = s.viewportWidth / factor;
        const sHeight = s.viewportHeight / factor;
        const canvas = document.createElement("canvas");
        canvas.width = frame.outputWidth;
        canvas.height = frame.outputHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(el, sx, sy, sWidth, sHeight, 0, 0, frame.outputWidth, frame.outputHeight);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, CROPPED_IMAGE_MIME_TYPE, CROPPED_IMAGE_QUALITY),
        );
        if (!blob) return null;
        const base = fileName.replace(/\.[^.]+$/, "") || "image";
        return new File([blob], `${base}.jpg`, { type: CROPPED_IMAGE_MIME_TYPE });
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, fileName, frame.outputWidth, frame.outputHeight]);

  return (
    <div className="image-crop">
      <div
        ref={viewportRef}
        className={`image-crop-viewport image-crop-viewport-${shape}`}
        style={{ aspectRatio: String(frame.aspectRatio) }}
        tabIndex={0}
        role="group"
        aria-label={panLabel}
        aria-describedby={hintId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          onLoad={onLoad}
          style={{ left: offset.x, top: offset.y, width: dispW, height: dispH }}
        />
      </div>
      {/* The wrapping label names the slider; an aria-label here would only repeat it. */}
      <label className="image-crop-zoom">
        <span>{zoomLabel}</span>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={scale}
          onChange={(e) => onZoom(parseFloat(e.target.value))}
        />
      </label>
      <p className="image-crop-hint" id={hintId}>
        {hint}
      </p>
    </div>
  );
}
