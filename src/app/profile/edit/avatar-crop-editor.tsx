"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// Square edit viewport (px) and the square output the cropped avatar is exported at.
const VIEWPORT = 264;
const OUTPUT = 512;
const MAX_ZOOM = 3;

export type AvatarCropApi = { getCropped: () => Promise<File | null> };

type Offset = { x: number; y: number };

// A minimal pan + zoom avatar cropper rendered inside the shared modal. The image is sized to
// cover the square viewport at zoom 1; the user drags to reposition and uses the slider to zoom.
// The parent reads the result through `apiRef.current.getCropped()` (wired to the modal's
// "Simpan foto" action) so no crop state has to leak back up.
export function AvatarCropEditor({
  src,
  fileName,
  apiRef,
}: {
  src: string;
  fileName: string;
  apiRef: { current: AvatarCropApi | null };
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });

  const baseScale = natural ? VIEWPORT / Math.min(natural.w, natural.h) : 1;
  const dispW = natural ? natural.w * baseScale * scale : VIEWPORT;
  const dispH = natural ? natural.h * baseScale * scale : VIEWPORT;

  // Keep the image covering the viewport — never expose an empty edge.
  const clampOffset = (o: Offset, w: number, h: number): Offset => ({
    x: Math.min(0, Math.max(VIEWPORT - w, o.x)),
    y: Math.min(0, Math.max(VIEWPORT - h, o.y)),
  });

  const onLoad = () => {
    const el = imgRef.current;
    if (!el) return;
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    const bs = VIEWPORT / Math.min(w, h);
    setNatural({ w, h });
    setScale(1);
    setOffset({ x: (VIEWPORT - w * bs) / 2, y: (VIEWPORT - h * bs) / 2 });
  };

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

  const onZoom = (z: number) => {
    if (!natural) {
      setScale(z);
      return;
    }
    // Zoom around the viewport centre so the framed subject stays put.
    const fx = (VIEWPORT / 2 - offset.x) / dispW;
    const fy = (VIEWPORT / 2 - offset.y) / dispH;
    const newW = natural.w * baseScale * z;
    const newH = natural.h * baseScale * z;
    setScale(z);
    setOffset(clampOffset({ x: VIEWPORT / 2 - fx * newW, y: VIEWPORT / 2 - fy * newH }, newW, newH));
  };

  // Latest crop state for the imperative getCropped (which is created once). Mirrored via an
  // effect rather than assigned during render (refs must not be written while rendering).
  const stateRef = useRef({ natural, baseScale, scale, offset });
  useEffect(() => {
    stateRef.current = { natural, baseScale, scale, offset };
  });

  useEffect(() => {
    apiRef.current = {
      getCropped: async () => {
        const el = imgRef.current;
        const s = stateRef.current;
        if (!el || !s.natural) return null;
        const factor = s.baseScale * s.scale;
        const sx = -s.offset.x / factor;
        const sy = -s.offset.y / factor;
        const sSize = VIEWPORT / factor;
        const canvas = document.createElement("canvas");
        canvas.width = OUTPUT;
        canvas.height = OUTPUT;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(el, sx, sy, sSize, sSize, 0, 0, OUTPUT, OUTPUT);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.9),
        );
        if (!blob) return null;
        const base = fileName.replace(/\.[^.]+$/, "") || "avatar";
        return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, fileName]);

  return (
    <div className="avatar-crop">
      <div
        className="avatar-crop-viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
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
      <label className="avatar-crop-zoom">
        <span>Perbesar</span>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={scale}
          onChange={(e) => onZoom(parseFloat(e.target.value))}
          aria-label="Perbesar foto"
        />
      </label>
      <p className="avatar-crop-hint">Seret gambar untuk menyesuaikan posisi.</p>
    </div>
  );
}
