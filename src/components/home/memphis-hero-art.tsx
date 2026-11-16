"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { PALM_INK, PAIRS } from "@/components/home/memphis-palette";

/*
 * Neo-Memphis / Y2K decorative panel for the homepage hero. Purely presentational
 * (aria-hidden). A dense grid of mixed-size tiles (1x1, 2x1, 1x2, 2x2 and L-shaped)
 * sits on the deep-palm hero; palm shows through wherever a tile is empty. The grid fills its
 * panel edge to edge: its column and row counts follow the panel's measured size, so the
 * layout is built on the client once the panel has a size.
 *
 * Behaviours:
 *  - Idle: on each tick a few filled tiles empty and a few empty tiles fill with a
 *    freshly chosen motif and colour, so the art relocates and changes rather than
 *    blinking in the same spot.
 *  - Pointer: the tile under the cursor is forced visible and held while hovered, and
 *    the whole grid drifts a few pixels toward the cursor (per-tile depth = parallax).
 * Both are suppressed under prefers-reduced-motion, where every tile stays visible.
 */

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

const CELL_TARGET_PX = 60;
const MIN_FILLED_SHARE = 0.8;
const INITIAL_EMPTY_SHARE = 0.1;
const INITIAL_EMPTY_EVERY = 7;

const CLEARING_MARGIN_PX = 48;
const CLEARING_POINT_DEPTH_PX = 120;
const CLEARING_ATTRIBUTE = "data-hero-clearing";

type Cell = { col: number; row: number; w: number; h: number; depth: number; clip?: string };
type GridShape = { columns: number; rows: number };
type Box = { left: number; top: number; right: number; bottom: number };
type CellSize = { width: number; height: number };
type GridGeometry = { shape: GridShape; outsideClearing: boolean[] };

function shapeFromPanelSize(width: number, height: number): GridShape | null {
  const columns = Math.round(width / CELL_TARGET_PX);
  const rows = Math.round(height / CELL_TARGET_PX);
  if (columns < 1 || rows < 1) return null;
  return { columns, rows };
}

function isSameGeometry(a: GridGeometry | null, b: GridGeometry | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.shape.columns !== b.shape.columns || a.shape.rows !== b.shape.rows) return false;
  return a.outsideClearing.every((outside, index) => outside === b.outsideClearing[index]);
}

/*
 * The clearing is a hexagon around the box that holds the heading and the search bar: flat top
 * and bottom edges CLEARING_MARGIN_PX away from the box, and left and right edges that start
 * CLEARING_MARGIN_PX out at the top and bottom and bend outward to a point at the box's vertical
 * middle, CLEARING_POINT_DEPTH_PX further out.
 */
function clearingSpanAt(clearing: Box, y: number): { left: number; right: number } {
  const zoneTop = clearing.top - CLEARING_MARGIN_PX;
  const middle = (clearing.top + clearing.bottom) / 2;
  const distanceFromEdgeToMiddle = middle - zoneTop;
  const closenessToPoint = 1 - Math.abs(y - middle) / distanceFromEdgeToMiddle;
  const outward = CLEARING_MARGIN_PX + CLEARING_POINT_DEPTH_PX * closenessToPoint;
  return { left: clearing.left - outward, right: clearing.right + outward };
}

// Touching the zone's edge is not overlapping it. The zone is widest at the box's vertical middle,
// so the row of the cell nearest that middle is the one where the cell reaches furthest in.
function cellOverlapsClearing(cell: Box, clearing: Box): boolean {
  const zoneTop = clearing.top - CLEARING_MARGIN_PX;
  const zoneBottom = clearing.bottom + CLEARING_MARGIN_PX;
  const overlapTop = Math.max(cell.top, zoneTop);
  const overlapBottom = Math.min(cell.bottom, zoneBottom);
  if (overlapTop >= overlapBottom) return false;

  const middle = (clearing.top + clearing.bottom) / 2;
  const nearestY = Math.min(Math.max(middle, overlapTop), overlapBottom);
  const span = clearingSpanAt(clearing, nearestY);
  return cell.right > span.left && cell.left < span.right;
}

/*
 * Reports, per grid unit in row-major order, whether the unit lies wholly outside the clearing.
 * The box is in the field's own coordinates, in pixels.
 */
export function findGridUnitsOutsideClearing({
  columns,
  rows,
  cellSize,
  clearing,
}: GridShape & { cellSize: CellSize; clearing: Box }): boolean[] {
  return Array.from({ length: columns * rows }, (_, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const cell: Box = {
      left: col * cellSize.width,
      top: row * cellSize.height,
      right: (col + 1) * cellSize.width,
      bottom: (row + 1) * cellSize.height,
    };
    return !cellOverlapsClearing(cell, clearing);
  });
}

function measureGridGeometry(field: HTMLElement): GridGeometry | null {
  const fieldRect = field.getBoundingClientRect();
  const shape = shapeFromPanelSize(fieldRect.width, fieldRect.height);
  if (!shape) return null;

  const clearingElement = field.parentElement?.querySelector(`[${CLEARING_ATTRIBUTE}]`);
  if (!clearingElement) {
    return { shape, outsideClearing: new Array<boolean>(shape.columns * shape.rows).fill(true) };
  }

  const clearingRect = clearingElement.getBoundingClientRect();
  const outsideClearing = findGridUnitsOutsideClearing({
    ...shape,
    cellSize: { width: fieldRect.width / shape.columns, height: fieldRect.height / shape.rows },
    clearing: {
      left: clearingRect.left - fieldRect.left,
      top: clearingRect.top - fieldRect.top,
      right: clearingRect.right - fieldRect.left,
      bottom: clearingRect.bottom - fieldRect.top,
    },
  });
  return { shape, outsideClearing };
}

/*
 * Tile the grid deterministically: scan cells row-major and drop the first shape that
 * fits into the top-left-most free cell, biased toward 2x1/1x2/2x2 pieces with 1x1 as
 * the always-available fallback. Units inside the clearing are marked occupied first, so no
 * piece covers them and the clearing's edge is a staircase of whole units. Row-major greedy
 * placement can never get stuck, so the pieces always cover every unit outside the clearing
 * exactly with no gaps or overflow. The seed makes a layout repeatable for one panel size and
 * clearing; every other 2x2 is clipped into an L-shape, palm showing through the notch.
 */
function buildTileLayout(
  { shape: { columns, rows }, outsideClearing }: GridGeometry,
  layoutSeed: number,
): Cell[] {
  const occupied = outsideClearing.map((outside) => !outside);
  const at = (row: number, col: number) => row * columns + col;

  let seed = layoutSeed >>> 0;
  const nextRandom = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const fits = (row: number, col: number, w: number, h: number) => {
    if (row + h > rows || col + w > columns) return false;
    for (let dr = 0; dr < h; dr += 1) {
      for (let dc = 0; dc < w; dc += 1) {
        if (occupied[at(row + dr, col + dc)]) return false;
      }
    }
    return true;
  };

  const cells: Cell[] = [];
  let bigTileCount = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
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

function motifPoolFor(cell: Cell): number[] {
  return cell.clip ? FILL_MOTIFS : ALL_MOTIFS;
}

function cellArea(cell: Cell): number {
  return cell.w * cell.h;
}

function totalCellArea(layout: Cell[]): number {
  return layout.reduce((sum, cell) => sum + cellArea(cell), 0);
}

type TileState = { filled: boolean; motif: number; pair: number };

// Every tile starts filled except a scattered few, whose combined area stays within
// INITIAL_EMPTY_SHARE of the grid, so the panel is never sparse.
function buildInitialTiles(layout: Cell[]): TileState[] {
  const emptyAreaBudget = totalCellArea(layout) * INITIAL_EMPTY_SHARE;
  let emptiedArea = 0;

  return layout.map((cell, index) => {
    const pool = motifPoolFor(cell);
    const isEmptyCandidate = index % INITIAL_EMPTY_EVERY === INITIAL_EMPTY_EVERY - 1;
    const fitsEmptyBudget = emptiedArea + cellArea(cell) <= emptyAreaBudget;
    const filled = !(isEmptyCandidate && fitsEmptyBudget);
    if (!filled) emptiedArea += cellArea(cell);
    return {
      filled,
      motif: pool[(index * 7) % pool.length] ?? pool[0] ?? 0,
      pair: (index * 5) % PAIRS.length,
    };
  });
}

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

type RelocatedTiles = { layout: Cell[]; tiles: TileState[] };

export function MemphisHeroArt({ layoutSeed }: { layoutSeed: number }): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const driftFrameRef = useRef<number | null>(null);
  const hoveredRef = useRef<number | null>(null);
  const [gridGeometry, setGridGeometry] = useState<GridGeometry | null>(null);
  const [relocated, setRelocated] = useState<RelocatedTiles | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  // The panel is hidden at 1199px and below (see .home-memphis in globals.css). CSS alone
  // would stop it being seen but not being computed — the tick below would keep re-rendering the
  // whole tile grid off-screen, on the devices least able to afford it. This mirrors the
  // reduced-motion query so both conditions silence the same interval.
  const [isNarrow, setIsNarrow] = useState(false);

  const layout = useMemo(
    () => (gridGeometry ? buildTileLayout(gridGeometry, layoutSeed) : []),
    [gridGeometry, layoutSeed],
  );
  const initialTiles = useMemo(() => buildInitialTiles(layout), [layout]);
  const tiles = relocated && relocated.layout === layout ? relocated.tiles : initialTiles;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      const nextGeometry = measureGridGeometry(panel);
      setGridGeometry((current) =>
        isSameGeometry(current, nextGeometry) ? current : nextGeometry,
      );
    });
    observer.observe(panel);
    const clearingElement = panel.parentElement?.querySelector(`[${CLEARING_ATTRIBUTE}]`);
    if (clearingElement) observer.observe(clearingElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1199px)");
    const sync = () => setIsNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (reducedMotion || isNarrow || layout.length === 0) return;
    const id = window.setInterval(() => {
      setRelocated((current) => {
        const currentTiles = current && current.layout === layout ? current.tiles : initialTiles;
        return { layout, tiles: relocateTiles(layout, currentTiles, hoveredRef.current) };
      });
    }, BLINK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [reducedMotion, isNarrow, layout, initialTiles]);

  function trackHover(index: number) {
    hoveredRef.current = index;
    setHovered(index);
  }

  function driftToCursor(clientX: number, clientY: number) {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const offsetX = (clientX - rect.left) / rect.width - 0.5;
    const offsetY = (clientY - rect.top) / rect.height - 0.5;
    if (driftFrameRef.current) cancelAnimationFrame(driftFrameRef.current);
    driftFrameRef.current = requestAnimationFrame(() => {
      panel.style.setProperty("--drift-x", `${offsetX * DRIFT_RANGE_PX}px`);
      panel.style.setProperty("--drift-y", `${offsetY * DRIFT_RANGE_PX}px`);
    });
  }

  function resetDrift() {
    hoveredRef.current = null;
    setHovered(null);
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.setProperty("--drift-x", "0px");
    panel.style.setProperty("--drift-y", "0px");
  }

  const gridTemplate: CSSProperties | undefined = gridGeometry
    ? {
        gridTemplateColumns: `repeat(${gridGeometry.shape.columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${gridGeometry.shape.rows}, minmax(0, 1fr))`,
      }
    : undefined;

  return (
    <div
      ref={panelRef}
      className="home-memphis"
      aria-hidden="true"
      onMouseMove={
        reducedMotion ? undefined : (event) => driftToCursor(event.clientX, event.clientY)
      }
      onMouseLeave={reducedMotion ? undefined : resetDrift}
    >
      <div className="home-memphis-grid" style={gridTemplate}>
        {tiles.map((tile, index) => {
          const cell = layout[index];
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
    </div>
  );
}

// Fills a few empty tiles first, then empties a few filled ones, but never empties a tile
// when that would take the filled area below MIN_FILLED_SHARE of the grid.
function relocateTiles(
  layout: Cell[],
  prev: TileState[],
  hoveredIndex: number | null,
): TileState[] {
  const next = prev.map((tile) => ({ ...tile }));
  const filled: number[] = [];
  const empty: number[] = [];
  next.forEach((tile, index) => {
    if (index === hoveredIndex) return;
    (tile.filled ? filled : empty).push(index);
  });

  for (let swap = 0; swap < SWAPS_PER_TICK && empty.length > 0; swap += 1) {
    const [target] = empty.splice(randomIndex(empty.length), 1);
    if (target === undefined) continue;
    const tile = next[target];
    const cell = layout[target];
    if (!tile || !cell) continue;
    tile.filled = true;
    tile.motif = pick(motifPoolFor(cell));
    tile.pair = randomIndex(PAIRS.length);
  }

  let filledArea = 0;
  next.forEach((tile, index) => {
    const cell = layout[index];
    if (tile.filled && cell) filledArea += cellArea(cell);
  });
  const minFilledArea = Math.ceil(totalCellArea(layout) * MIN_FILLED_SHARE);

  for (let swap = 0; swap < SWAPS_PER_TICK && filled.length > 0; swap += 1) {
    const [target] = filled.splice(randomIndex(filled.length), 1);
    if (target === undefined) continue;
    const tile = next[target];
    const cell = layout[target];
    if (!tile || !cell) continue;
    if (filledArea - cellArea(cell) < minFilledArea) continue;
    tile.filled = false;
    filledArea -= cellArea(cell);
  }

  return next;
}
