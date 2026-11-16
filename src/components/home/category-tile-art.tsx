import type { ReactElement } from "react";
import type { CompetitionCategory } from "@/server/db/schema";
import { LIME, PALM, PAPER, TANGERINE } from "@/components/home/memphis-palette";

/*
 * One drawing per competition category, in the motif style of the hero tiles: flat shapes on the
 * Deep Palm ground of the tile. Lime carries the drawing, Warm Paper is its second colour,
 * Tangerine is a small accent and Deep Palm shows as the cut-outs inside a shape. The record is
 * keyed by CompetitionCategory, so a category added to the enum without a drawing is a compile
 * error. Drawings are on a 100 x 100 canvas and do not animate.
 */

type TileColors = { main: string; second: string; accent: string; cutout: string };

const TILE_COLORS: TileColors = { main: LIME, second: PAPER, accent: TANGERINE, cutout: PALM };

const TILE_DRAWINGS: Record<CompetitionCategory, (colors: TileColors) => ReactElement> = {
  olympiad: ({ main, second, accent, cutout }) => (
    <>
      <path d="M30 6 H46 L58 44 H42 Z" fill={second} />
      <path d="M70 6 H54 L42 44 H58 Z" fill={second} />
      <circle cx="50" cy="66" r="26" fill={main} />
      <circle cx="50" cy="66" r="18" fill="none" stroke={cutout} strokeWidth="4" />
      <polygon points="50 55 53 63 62 63 55 68 58 77 50 72 42 77 45 68 38 63 47 63" fill={accent} />
    </>
  ),
  scientific_writing: ({ main, second, cutout }) => (
    <>
      <rect x="24" y="10" width="52" height="80" rx="6" fill={main} />
      <path d="M62 10 L76 24 H62 Z" fill={second} />
      <g stroke={cutout} strokeWidth="6" strokeLinecap="round">
        <line x1="36" y1="36" x2="64" y2="36" />
        <line x1="36" y1="50" x2="64" y2="50" />
        <line x1="36" y1="64" x2="64" y2="64" />
        <line x1="36" y1="78" x2="52" y2="78" />
      </g>
    </>
  ),
  essay: ({ main, accent, cutout }) => (
    <>
      <path d="M50 8 C62 28 74 44 70 66 L50 94 L30 66 C26 44 38 28 50 8 Z" fill={main} />
      <circle cx="50" cy="48" r="6" fill={accent} />
      <line x1="50" y1="54" x2="50" y2="88" stroke={cutout} strokeWidth="4" strokeLinecap="round" />
    </>
  ),
  debate: ({ main, second, cutout }) => (
    <>
      <path
        d="M10 14 H62 A8 8 0 0 1 70 22 V46 A8 8 0 0 1 62 54 H36 L22 68 V54 H10 A8 8 0 0 1 2 46 V22 A8 8 0 0 1 10 14 Z"
        fill={main}
      />
      <path
        d="M38 40 H90 A8 8 0 0 1 98 48 V72 A8 8 0 0 1 90 80 H84 V94 L70 80 H38 A8 8 0 0 1 30 72 V48 A8 8 0 0 1 38 40 Z"
        fill={second}
        stroke={cutout}
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <g fill={cutout}>
        <circle cx="46" cy="60" r="4" />
        <circle cx="64" cy="60" r="4" />
        <circle cx="82" cy="60" r="4" />
      </g>
    </>
  ),
  quiz: ({ main, accent }) => (
    <>
      <path
        d="M32 34 C32 12 68 12 68 36 C68 52 50 52 50 66"
        fill="none"
        stroke={main}
        strokeWidth="12"
        strokeLinecap="round"
      />
      <circle cx="50" cy="86" r="7" fill={accent} />
    </>
  ),
  business: ({ main, second }) => (
    <>
      <rect x="12" y="58" width="18" height="30" rx="3" fill={main} />
      <rect x="41" y="40" width="18" height="48" rx="3" fill={main} />
      <rect x="70" y="14" width="18" height="74" rx="3" fill={second} />
    </>
  ),
  hackathon: ({ main, second }) => (
    <g fill="none" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round">
      <path d="M34 24 L10 50 L34 76" stroke={main} />
      <path d="M66 24 L90 50 L66 76" stroke={main} />
      <line x1="56" y1="16" x2="44" y2="84" stroke={second} />
    </g>
  ),
  design: ({ main, second }) => (
    <>
      <g stroke={second} strokeWidth="3">
        <line x1="14" y1="78" x2="30" y2="16" />
        <line x1="86" y1="78" x2="70" y2="16" />
      </g>
      <path
        d="M14 78 C30 16 70 16 86 78"
        fill="none"
        stroke={main}
        strokeWidth="6"
        strokeLinecap="round"
      />
      <g fill={second}>
        <circle cx="30" cy="16" r="6" />
        <circle cx="70" cy="16" r="6" />
        <rect x="7" y="71" width="14" height="14" />
        <rect x="79" y="71" width="14" height="14" />
      </g>
    </>
  ),
  infographics: ({ main, second }) => (
    <>
      <path d="M50 50 L82.9 69 A38 38 0 1 1 50 12 Z" fill={main} />
      <path d="M56 44 L56 6 A38 38 0 0 1 88.9 63 Z" fill={second} />
    </>
  ),
  engineering: ({ main, cutout }) => (
    <>
      <g fill={main}>
        {Array.from({ length: 8 }, (_, tooth) => (
          <rect
            key={tooth}
            x="43"
            y="6"
            width="14"
            height="22"
            rx="3"
            transform={`rotate(${tooth * 45} 50 50)`}
          />
        ))}
        <circle cx="50" cy="50" r="32" />
      </g>
      <circle cx="50" cy="50" r="13" fill={cutout} />
    </>
  ),
  finance: ({ main, second, cutout }) => (
    <g stroke={cutout} strokeWidth="3">
      {[70, 52, 34].map((top) => {
        const coinFill = top === 34 ? second : main;
        return (
          <g key={top}>
            <ellipse cx="50" cy={top + 12} rx="30" ry="10" fill={coinFill} />
            <rect x="20" y={top} width="60" height="12" fill={coinFill} stroke="none" />
            <ellipse cx="50" cy={top} rx="30" ry="10" fill={coinFill} />
          </g>
        );
      })}
    </g>
  ),
  law: ({ main, second }) => (
    <>
      <g stroke={main} strokeLinecap="round">
        <line x1="50" y1="22" x2="50" y2="82" strokeWidth="6" />
        <line x1="18" y1="26" x2="82" y2="26" strokeWidth="6" />
        <g strokeWidth="3">
          <line x1="18" y1="26" x2="4" y2="56" />
          <line x1="18" y1="26" x2="32" y2="56" />
          <line x1="82" y1="26" x2="68" y2="56" />
          <line x1="82" y1="26" x2="96" y2="56" />
        </g>
      </g>
      <g fill={main}>
        <circle cx="50" cy="20" r="6" />
        <rect x="30" y="82" width="40" height="8" rx="4" />
      </g>
      <g fill={second}>
        <path d="M2 56 H34 A16 16 0 0 1 2 56 Z" />
        <path d="M66 56 H98 A16 16 0 0 1 66 56 Z" />
      </g>
    </>
  ),
  data_science: ({ main, second, accent }) => (
    <>
      <line x1="12" y1="78" x2="88" y2="24" stroke={main} strokeWidth="5" strokeLinecap="round" />
      <g fill={second}>
        <circle cx="22" cy="58" r="6" />
        <circle cx="30" cy="76" r="6" />
        <circle cx="40" cy="44" r="6" />
        <circle cx="52" cy="62" r="6" />
        <circle cx="62" cy="34" r="6" />
        <circle cx="74" cy="50" r="6" />
        <circle cx="26" cy="30" r="6" />
      </g>
      <circle cx="84" cy="14" r="6" fill={accent} />
    </>
  ),
  programming: ({ main, second }) => (
    <g fill="none" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="16" width="84" height="68" rx="10" stroke={main} />
      <path d="M24 38 L40 50 L24 62" stroke={second} />
      <line x1="48" y1="62" x2="70" y2="62" stroke={second} />
    </g>
  ),
  marketing: ({ main, second }) => (
    <>
      <g fill={main}>
        <path d="M14 38 H34 L72 16 V84 L34 62 H14 Z" />
        <rect x="22" y="62" width="12" height="24" rx="4" />
      </g>
      <g fill="none" stroke={second} strokeWidth="6" strokeLinecap="round">
        <path d="M80 40 A10 10 0 0 1 80 60" />
        <path d="M82 28 A24 24 0 0 1 82 72" />
      </g>
    </>
  ),
  digital_art: ({ main, second, accent }) => (
    <>
      <path
        d="M10 70 C28 30 44 90 62 48 S86 30 90 40"
        fill="none"
        stroke={main}
        strokeWidth="16"
        strokeLinecap="round"
      />
      <circle cx="20" cy="22" r="5" fill={second} />
      <circle cx="78" cy="78" r="5" fill={accent} />
    </>
  ),
  performing_arts: ({ main, cutout }) => (
    <>
      <path d="M14 14 H86 V46 C86 72 68 90 50 90 C32 90 14 72 14 46 Z" fill={main} />
      <g fill={cutout}>
        <path d="M28 38 Q36 30 44 38 Q36 44 28 38 Z" />
        <path d="M56 38 Q64 30 72 38 Q64 44 56 38 Z" />
      </g>
      <path
        d="M32 62 Q50 80 68 62"
        fill="none"
        stroke={cutout}
        strokeWidth="6"
        strokeLinecap="round"
      />
    </>
  ),
  esports: ({ main, accent, cutout }) => (
    <>
      <path
        d="M24 28 H76 C90 28 98 44 94 66 C92 78 84 82 76 76 L66 66 H34 L24 76 C16 82 8 78 6 66 C2 44 10 28 24 28 Z"
        fill={main}
      />
      <g fill={cutout}>
        <rect x="22" y="44" width="20" height="7" rx="2" />
        <rect x="28.5" y="37.5" width="7" height="20" rx="2" />
      </g>
      <g fill={accent}>
        <circle cx="68" cy="42" r="4.5" />
        <circle cx="78" cy="52" r="4.5" />
      </g>
    </>
  ),
  other: ({ main, second }) => (
    <>
      <g fill={main}>
        <circle cx="28" cy="28" r="14" />
        <polygon points="28 58 42 86 14 86" />
      </g>
      <g fill={second}>
        <rect x="58" y="14" width="28" height="28" rx="6" />
        <polygon points="72 56 88 72 72 88 56 72" />
      </g>
    </>
  ),
};

export function CategoryTileArt({ category }: { category: CompetitionCategory }): ReactElement {
  const drawTile = TILE_DRAWINGS[category];

  return (
    <span className="home-category-art" aria-hidden="true">
      <svg viewBox="0 0 100 100">{drawTile(TILE_COLORS)}</svg>
    </span>
  );
}
