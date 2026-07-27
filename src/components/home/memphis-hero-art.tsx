"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";

/*
 * Neo-Memphis / Y2K decorative panel for the homepage hero. Purely presentational
 * (aria-hidden). A dense grid of mixed-size tiles (1x1, 2x1, 1x2, 2x2 and L-shaped)
 * sits on the deep-palm hero; palm shows through wherever a tile is empty.
 *
 * Behaviours:
 *  - Idle: on each tick a few filled tiles empty and a few empty tiles fill with a
 *    freshly chosen motif and colour, so the art relocates and changes rather than
 *    blinking in the same spot.
 *  - Pointer: the tile under the cursor is forced visible and held while hovered, and
 *    the whole grid drifts a few pixels toward the cursor (per-tile depth = parallax).
 * Both are suppressed under prefers-reduced-motion, where every tile stays visible.
 */

const PALM = "#14453d";
const PALM_INK = "#0e332d";
const TANGERINE = "#f4632a";
const TERRACOTTA = "#c6491b";
const PAPER = "#fbf6eb";
const LIME = "#d0f05e";
const LIME_DEEP = "#9db53c";
const PEACH = "#ffd3b0";
const BLUSH = "#ffe9da";
const MIST = "#e4ede4";

/*
 * Curated ground/ink pairs, drawn only from the brand book palette (Brand Book
 * v2 — docs/product/ui-preferences.md). Every pair keeps the motif legible on
 * its ground.
 */
type ColorPair = { ground: string; ink: string };
const PAIRS: ColorPair[] = [
  { ground: LIME, ink: PALM },
  { ground: LIME, ink: TANGERINE },
  { ground: LIME, ink: TERRACOTTA },
  { ground: TANGERINE, ink: PALM },
  { ground: TANGERINE, ink: PAPER },
  { ground: PALM, ink: LIME },
  { ground: PALM, ink: PEACH },
  { ground: PEACH, ink: TERRACOTTA },
  { ground: PEACH, ink: PALM },
  { ground: PAPER, ink: TERRACOTTA },
  { ground: PAPER, ink: TANGERINE },
  { ground: TERRACOTTA, ink: PAPER },
  { ground: BLUSH, ink: TERRACOTTA },
  { ground: BLUSH, ink: PALM },
  { ground: MIST, ink: PALM },
  { ground: PALM_INK, ink: LIME },
  { ground: LIME_DEEP, ink: PALM_INK },
  { ground: TANGERINE, ink: PALM_INK },
];

/*
 * Motifs 0-8 are single objects (kept square, centred in the tile); motifs 9-14 are
 * fill patterns that stretch edge-to-edge and so suit rectangles and L-shapes.
 */
const OBJECT_MOTIFS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const FILL_MOTIFS = [9, 10, 11, 12, 13, 14];
const ALL_MOTIFS = [...OBJECT_MOTIFS, ...FILL_MOTIFS];

function isFillMotif(motif: number): boolean {
  return motif >= 9;
}

const L_BR = "polygon(0 0, 50% 0, 50% 50%, 100% 50%, 100% 100%, 0 100%)";
const L_TL = "polygon(0 0, 100% 0, 100% 100%, 50% 100%, 50% 50%, 0 50%)";
const L_TR = "polygon(0 0, 100% 0, 100% 50%, 50% 50%, 50% 100%, 0 100%)";
const L_BL = "polygon(50% 0, 100% 0, 100% 100%, 0 100%, 0 50%, 50% 50%)";
const L_CLIPS = [L_BR, L_TL, L_TR, L_BL];

const GRID_SIZE = 9;

type Cell = { col: number; row: number; w: number; h: number; depth: number; clip?: string };

/*
 * Tile the square grid deterministically: scan cells row-major and drop the first
 * shape that fits into the top-left-most free cell, biased toward 2x1/1x2/2x2 pieces
 * with 1x1 as the always-available fallback. Row-major greedy placement can never get
 * stuck, so the pieces always cover the grid exactly with no gaps or overflow. A fixed
 * seed keeps the layout identical on server and client (no hydration mismatch); every
 * other 2x2 is clipped into an L-shape, palm showing through the notch.
 */
function buildLayout(size: number): Cell[] {
  const occupied = new Array<boolean>(size * size).fill(false);
  const at = (row: number, col: number) => row * size + col;

  let seed = 0x9e3779b1;
  const nextRandom = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const fits = (row: number, col: number, w: number, h: number) => {
    if (row + h > size || col + w > size) return false;
    for (let dr = 0; dr < h; dr += 1) {
      for (let dc = 0; dc < w; dc += 1) {
        if (occupied[at(row + dr, col + dc)]) return false;
      }
    }
    return true;
  };

  const cells: Cell[] = [];
  let bigTileCount = 0;

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (occupied[at(row, col)]) continue;

      const larger: Array<[number, number]> = [];
      if (fits(row, col, 2, 2)) larger.push([2, 2]);
      if (fits(row, col, 2, 1)) larger.push([2, 1]);
      if (fits(row, col, 1, 2)) larger.push([1, 2]);

      const [w, h] =
        larger.length > 0 && nextRandom() < 0.82
          ? (larger[Math.floor(nextRandom() * larger.length)] ?? [1, 1])
          : [1, 1];

      for (let dr = 0; dr < h; dr += 1) {
        for (let dc = 0; dc < w; dc += 1) {
          occupied[at(row + dr, col + dc)] = true;
        }
      }

      const cell: Cell = {
        col: col + 1,
        row: row + 1,
        w,
        h,
        depth: 0.4 + ((cells.length * 3) % 10) * 0.1,
      };
      if (w === 2 && h === 2) {
        bigTileCount += 1;
        if (bigTileCount % 2 === 0) {
          cell.clip = L_CLIPS[Math.floor(nextRandom() * L_CLIPS.length)];
        }
      }
      cells.push(cell);
    }
  }

  return cells;
}

const LAYOUT: Cell[] = buildLayout(GRID_SIZE);

function motifPoolFor(cell: Cell): number[] {
  return cell.clip ? FILL_MOTIFS : ALL_MOTIFS;
}

type TileState = { filled: boolean; motif: number; pair: number };

const INITIAL_TILES: TileState[] = LAYOUT.map((cell, index) => {
  const pool = motifPoolFor(cell);
  return {
    filled: index % 3 === 0,
    motif: pool[(index * 7) % pool.length] ?? pool[0] ?? 0,
    pair: (index * 5) % PAIRS.length,
  };
});

const BLINK_INTERVAL_MS = 500;
const SWAPS_PER_TICK = 3;
const DRIFT_RANGE_PX = 46;

function randomIndex(length: number): number {
  return Math.floor(Math.random() * length);
}

function pick<T>(items: T[]): T {
  return items[randomIndex(items.length)] as T;
}

function renderMotif(motif: number, ink: string): ReactElement {
  const fill = isFillMotif(motif);
  const ratio = fill ? "none" : "xMidYMid meet";
  switch (motif) {
    case 0:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <circle cx="50" cy="50" r="40" fill={ink} />
          <rect x="35" y="32" width="9" height="18" rx="4" fill={PALM_INK} />
          <rect x="56" y="32" width="9" height="18" rx="4" fill={PALM_INK} />
          <path d="M32 58 A18 18 0 0 0 68 58 Z" fill={PALM_INK} />
        </svg>
      );
    case 1:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <path
            d="M50 10 C76 10 92 28 90 52 C88 76 72 92 48 90 C26 88 10 72 12 46 C14 24 24 10 50 10 Z"
            fill={ink}
          />
        </svg>
      );
    case 2:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <path
            d="M50 8 L62 38 L94 38 L68 58 L78 90 L50 70 L22 90 L32 58 L6 38 L38 38 Z"
            fill={ink}
          />
        </svg>
      );
    case 3:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <path
            d="M50 8 C55 40 60 45 92 50 C60 55 55 60 50 92 C45 60 40 55 8 50 C40 45 45 40 50 8 Z"
            fill={ink}
          />
        </svg>
      );
    case 4:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <g stroke={ink} strokeWidth="13" strokeLinecap="round">
            <line x1="50" y1="12" x2="50" y2="88" />
            <line x1="12" y1="50" x2="88" y2="50" />
            <line x1="23" y1="23" x2="77" y2="77" />
            <line x1="77" y1="23" x2="23" y2="77" />
          </g>
        </svg>
      );
    case 5:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <g fill="none" stroke={ink} strokeWidth="9">
            <circle cx="50" cy="50" r="38" />
            <circle cx="50" cy="50" r="22" />
          </g>
          <circle cx="50" cy="50" r="8" fill={ink} />
        </svg>
      );
    case 6:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <g fill="none" stroke={ink} strokeWidth="10" strokeLinecap="round">
            <path d="M14 82 A36 36 0 0 1 86 82" />
            <path d="M32 82 A18 18 0 0 1 68 82" />
          </g>
        </svg>
      );
    case 7:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <circle cx="50" cy="50" r="16" fill={ink} />
          <g stroke={ink} strokeWidth="8" strokeLinecap="round">
            {Array.from({ length: 8 }, (_, ray) => {
              const angle = (ray * Math.PI) / 4;
              return (
                <line
                  key={ray}
                  x1={50 + 26 * Math.cos(angle)}
                  y1={50 + 26 * Math.sin(angle)}
                  x2={50 + 44 * Math.cos(angle)}
                  y2={50 + 44 * Math.sin(angle)}
                />
              );
            })}
          </g>
        </svg>
      );
    case 8:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <g fill={ink}>
            {Array.from({ length: 8 }, (_, petal) => {
              const angle = (petal * Math.PI) / 4;
              return (
                <circle
                  key={petal}
                  cx={50 + 26 * Math.cos(angle)}
                  cy={50 + 26 * Math.sin(angle)}
                  r="15"
                />
              );
            })}
            <circle cx="50" cy="50" r="15" fill={PALM_INK} />
          </g>
        </svg>
      );
    case 9:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          {Array.from({ length: 16 }, (_, cell) => {
            const row = Math.floor(cell / 4);
            const col = cell % 4;
            if ((row + col) % 2 !== 0) return null;
            return <rect key={cell} x={col * 25} y={row * 25} width="25" height="25" fill={ink} />;
          })}
        </svg>
      );
    case 10:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          {Array.from({ length: 16 }, (_, cell) => {
            const row = Math.floor(cell / 4);
            const col = cell % 4;
            return <circle key={cell} cx={12.5 + col * 25} cy={12.5 + row * 25} r="8" fill={ink} />;
          })}
        </svg>
      );
    case 11:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          {[0, 1, 2, 3].map((bar) => (
            <rect key={bar} x={bar * 25 + 4} y="0" width="14" height="100" fill={ink} />
          ))}
        </svg>
      );
    case 12:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <g fill="none" stroke={ink} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M0 30 L25 12 L50 30 L75 12 L100 30" />
            <path d="M0 58 L25 40 L50 58 L75 40 L100 58" />
            <path d="M0 86 L25 68 L50 86 L75 68 L100 86" />
          </g>
        </svg>
      );
    case 13:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <g fill="none" stroke={ink} strokeWidth="8" strokeLinecap="round">
            <path d="M0 25 Q17 8 34 25 T68 25 T102 25" />
            <path d="M0 55 Q17 38 34 55 T68 55 T102 55" />
            <path d="M0 85 Q17 68 34 85 T68 85 T102 85" />
          </g>
        </svg>
      );
    case 14:
      return (
        <svg viewBox="0 0 100 100" preserveAspectRatio={ratio}>
          <g stroke={ink} strokeWidth="8" strokeLinecap="round">
            {Array.from({ length: 9 }, (_, cell) => {
              const cx = 16.7 + (cell % 3) * 33.3;
              const cy = 16.7 + Math.floor(cell / 3) * 33.3;
              return (
                <g key={cell}>
                  <line x1={cx - 9} y1={cy} x2={cx + 9} y2={cy} />
                  <line x1={cx} y1={cy - 9} x2={cx} y2={cy + 9} />
                </g>
              );
            })}
          </g>
        </svg>
      );
    default:
      return <svg viewBox="0 0 100 100" preserveAspectRatio={ratio} />;
  }
}

export function MemphisHeroArt(): ReactElement {
  const gridRef = useRef<HTMLDivElement>(null);
  const driftFrameRef = useRef<number | null>(null);
  const hoveredRef = useRef<number | null>(null);
  const [tiles, setTiles] = useState<TileState[]>(INITIAL_TILES);
  const [hovered, setHovered] = useState<number | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (reducedMotion) return;
    const id = window.setInterval(() => {
      setTiles((prev) => relocateTiles(prev, hoveredRef.current));
    }, BLINK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [reducedMotion]);

  function trackHover(index: number) {
    hoveredRef.current = index;
    setHovered(index);
  }

  function driftToCursor(clientX: number, clientY: number) {
    const grid = gridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const offsetX = (clientX - rect.left) / rect.width - 0.5;
    const offsetY = (clientY - rect.top) / rect.height - 0.5;
    if (driftFrameRef.current) cancelAnimationFrame(driftFrameRef.current);
    driftFrameRef.current = requestAnimationFrame(() => {
      grid.style.setProperty("--drift-x", `${offsetX * DRIFT_RANGE_PX}px`);
      grid.style.setProperty("--drift-y", `${offsetY * DRIFT_RANGE_PX}px`);
    });
  }

  function resetDrift() {
    hoveredRef.current = null;
    setHovered(null);
    const grid = gridRef.current;
    if (!grid) return;
    grid.style.setProperty("--drift-x", "0px");
    grid.style.setProperty("--drift-y", "0px");
  }

  return (
    <div
      ref={gridRef}
      className="home-memphis"
      aria-hidden="true"
      onMouseMove={
        reducedMotion ? undefined : (event) => driftToCursor(event.clientX, event.clientY)
      }
      onMouseLeave={reducedMotion ? undefined : resetDrift}
    >
      {tiles.map((tile, index) => {
        const cell = LAYOUT[index];
        const pair = PAIRS[tile.pair];
        if (!cell || !pair) return null;
        const shown = reducedMotion || tile.filled || hovered === index;
        return (
          <div
            key={index}
            className="home-memphis-tile"
            style={
              {
                gridColumn: `${cell.col} / span ${cell.w}`,
                gridRow: `${cell.row} / span ${cell.h}`,
                "--tile-depth": cell.depth,
              } as CSSProperties
            }
            onMouseEnter={reducedMotion ? undefined : () => trackHover(index)}
          >
            <span
              className="home-memphis-fill"
              data-active={shown}
              style={{ background: pair.ground, clipPath: cell.clip }}
            >
              <span className="home-memphis-art" data-fill={isFillMotif(tile.motif)}>
                {renderMotif(tile.motif, pair.ink)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function relocateTiles(prev: TileState[], hoveredIndex: number | null): TileState[] {
  const next = prev.map((tile) => ({ ...tile }));
  const filled: number[] = [];
  const empty: number[] = [];
  next.forEach((tile, index) => {
    if (index === hoveredIndex) return;
    (tile.filled ? filled : empty).push(index);
  });

  for (let swap = 0; swap < SWAPS_PER_TICK && filled.length > 0; swap += 1) {
    const [target] = filled.splice(randomIndex(filled.length), 1);
    if (target === undefined) continue;
    const tile = next[target];
    if (tile) tile.filled = false;
  }

  for (let swap = 0; swap < SWAPS_PER_TICK && empty.length > 0; swap += 1) {
    const [target] = empty.splice(randomIndex(empty.length), 1);
    if (target === undefined) continue;
    const tile = next[target];
    const cell = LAYOUT[target];
    if (!tile || !cell) continue;
    tile.filled = true;
    tile.motif = pick(motifPoolFor(cell));
    tile.pair = randomIndex(PAIRS.length);
  }

  return next;
}
