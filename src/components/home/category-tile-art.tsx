import type { ReactElement } from "react";
import type { CompetitionCategory } from "@/server/db/schema";
import { pairAt } from "@/components/home/memphis-palette";

/*
 * One drawing per competition category, in the motif style of the hero tiles: a flat ink shape on
 * a curated ground. The record is keyed by CompetitionCategory, so a category added to the enum
 * without a drawing is a compile error. Drawings are on a 100 x 100 canvas, use only the pair's
 * ink and ground, and do not animate.
 */

type TileDrawing = {
  pairIndex: number;
  draw: (ink: string, ground: string) => ReactElement;
};

const TILE_DRAWINGS: Record<CompetitionCategory, TileDrawing> = {
  olympiad: {
    pairIndex: 4,
    draw: (ink, ground) => (
      <>
        <path d="M30 6 H46 L58 44 H42 Z" fill={ink} />
        <path d="M70 6 H54 L42 44 H58 Z" fill={ink} />
        <circle cx="50" cy="66" r="26" fill={ink} />
        <circle cx="50" cy="66" r="18" fill="none" stroke={ground} strokeWidth="4" />
        <polygon
          points="50 55 53 63 62 63 55 68 58 77 50 72 42 77 45 68 38 63 47 63"
          fill={ground}
        />
      </>
    ),
  },
  scientific_writing: {
    pairIndex: 14,
    draw: (ink, ground) => (
      <>
        <rect x="24" y="10" width="52" height="80" rx="6" fill={ink} />
        <path d="M62 10 L76 24 H62 Z" fill={ground} />
        <g stroke={ground} strokeWidth="6" strokeLinecap="round">
          <line x1="36" y1="36" x2="64" y2="36" />
          <line x1="36" y1="50" x2="64" y2="50" />
          <line x1="36" y1="64" x2="64" y2="64" />
          <line x1="36" y1="78" x2="52" y2="78" />
        </g>
      </>
    ),
  },
  essay: {
    pairIndex: 7,
    draw: (ink, ground) => (
      <>
        <path d="M50 8 C62 28 74 44 70 66 L50 94 L30 66 C26 44 38 28 50 8 Z" fill={ink} />
        <circle cx="50" cy="48" r="6" fill={ground} />
        <line
          x1="50"
          y1="54"
          x2="50"
          y2="88"
          stroke={ground}
          strokeWidth="4"
          strokeLinecap="round"
        />
      </>
    ),
  },
  debate: {
    pairIndex: 5,
    draw: (ink, ground) => (
      <>
        <path
          d="M10 14 H62 A8 8 0 0 1 70 22 V46 A8 8 0 0 1 62 54 H36 L22 68 V54 H10 A8 8 0 0 1 2 46 V22 A8 8 0 0 1 10 14 Z"
          fill={ink}
        />
        <path
          d="M38 40 H90 A8 8 0 0 1 98 48 V72 A8 8 0 0 1 90 80 H84 V94 L70 80 H38 A8 8 0 0 1 30 72 V48 A8 8 0 0 1 38 40 Z"
          fill={ink}
          stroke={ground}
          strokeWidth="4"
          strokeLinejoin="round"
        />
        <g fill={ground}>
          <circle cx="46" cy="60" r="4" />
          <circle cx="64" cy="60" r="4" />
          <circle cx="82" cy="60" r="4" />
        </g>
      </>
    ),
  },
  quiz: {
    pairIndex: 0,
    draw: (ink) => (
      <>
        <path
          d="M32 34 C32 12 68 12 68 36 C68 52 50 52 50 66"
          fill="none"
          stroke={ink}
          strokeWidth="12"
          strokeLinecap="round"
        />
        <circle cx="50" cy="86" r="7" fill={ink} />
      </>
    ),
  },
  business: {
    pairIndex: 12,
    draw: (ink) => (
      <g fill={ink}>
        <rect x="12" y="58" width="18" height="30" rx="3" />
        <rect x="41" y="40" width="18" height="48" rx="3" />
        <rect x="70" y="14" width="18" height="74" rx="3" />
      </g>
    ),
  },
  hackathon: {
    pairIndex: 15,
    draw: (ink) => (
      <g fill="none" stroke={ink} strokeWidth="11" strokeLinecap="round" strokeLinejoin="round">
        <path d="M34 24 L10 50 L34 76" />
        <path d="M66 24 L90 50 L66 76" />
        <line x1="56" y1="16" x2="44" y2="84" />
      </g>
    ),
  },
  design: {
    pairIndex: 11,
    draw: (ink) => (
      <>
        <g stroke={ink} strokeWidth="3">
          <line x1="14" y1="78" x2="30" y2="16" />
          <line x1="86" y1="78" x2="70" y2="16" />
        </g>
        <path
          d="M14 78 C30 16 70 16 86 78"
          fill="none"
          stroke={ink}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <g fill={ink}>
          <circle cx="30" cy="16" r="6" />
          <circle cx="70" cy="16" r="6" />
          <rect x="7" y="71" width="14" height="14" />
          <rect x="79" y="71" width="14" height="14" />
        </g>
      </>
    ),
  },
  infographics: {
    pairIndex: 16,
    draw: (ink) => (
      <g fill={ink}>
        <path d="M50 50 L82.9 69 A38 38 0 1 1 50 12 Z" />
        <path d="M56 44 L56 6 A38 38 0 0 1 88.9 63 Z" />
      </g>
    ),
  },
  engineering: {
    pairIndex: 8,
    draw: (ink, ground) => (
      <>
        <g fill={ink}>
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
        <circle cx="50" cy="50" r="13" fill={ground} />
      </>
    ),
  },
  finance: {
    pairIndex: 2,
    draw: (ink, ground) => (
      <g fill={ink} stroke={ground} strokeWidth="3">
        {[70, 52, 34].map((top) => (
          <g key={top}>
            <ellipse cx="50" cy={top + 12} rx="30" ry="10" />
            <rect x="20" y={top} width="60" height="12" stroke="none" />
            <ellipse cx="50" cy={top} rx="30" ry="10" />
          </g>
        ))}
      </g>
    ),
  },
  law: {
    pairIndex: 6,
    draw: (ink) => (
      <>
        <g stroke={ink} strokeLinecap="round">
          <line x1="50" y1="22" x2="50" y2="82" strokeWidth="6" />
          <line x1="18" y1="26" x2="82" y2="26" strokeWidth="6" />
          <g strokeWidth="3">
            <line x1="18" y1="26" x2="4" y2="56" />
            <line x1="18" y1="26" x2="32" y2="56" />
            <line x1="82" y1="26" x2="68" y2="56" />
            <line x1="82" y1="26" x2="96" y2="56" />
          </g>
        </g>
        <g fill={ink}>
          <circle cx="50" cy="20" r="6" />
          <path d="M2 56 H34 A16 16 0 0 1 2 56 Z" />
          <path d="M66 56 H98 A16 16 0 0 1 66 56 Z" />
          <rect x="30" y="82" width="40" height="8" rx="4" />
        </g>
      </>
    ),
  },
  data_science: {
    pairIndex: 3,
    draw: (ink) => (
      <>
        <line x1="12" y1="78" x2="88" y2="24" stroke={ink} strokeWidth="5" strokeLinecap="round" />
        <g fill={ink}>
          <circle cx="22" cy="58" r="6" />
          <circle cx="30" cy="76" r="6" />
          <circle cx="40" cy="44" r="6" />
          <circle cx="52" cy="62" r="6" />
          <circle cx="62" cy="34" r="6" />
          <circle cx="74" cy="50" r="6" />
          <circle cx="84" cy="14" r="6" />
          <circle cx="26" cy="30" r="6" />
        </g>
      </>
    ),
  },
  programming: {
    pairIndex: 13,
    draw: (ink) => (
      <g fill="none" stroke={ink} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="8" y="16" width="84" height="68" rx="10" />
        <path d="M24 38 L40 50 L24 62" />
        <line x1="48" y1="62" x2="70" y2="62" />
      </g>
    ),
  },
  marketing: {
    pairIndex: 17,
    draw: (ink) => (
      <>
        <g fill={ink}>
          <path d="M14 38 H34 L72 16 V84 L34 62 H14 Z" />
          <rect x="22" y="62" width="12" height="24" rx="4" />
        </g>
        <g fill="none" stroke={ink} strokeWidth="6" strokeLinecap="round">
          <path d="M80 40 A10 10 0 0 1 80 60" />
          <path d="M82 28 A24 24 0 0 1 82 72" />
        </g>
      </>
    ),
  },
  digital_art: {
    pairIndex: 10,
    draw: (ink) => (
      <>
        <path
          d="M10 70 C28 30 44 90 62 48 S86 30 90 40"
          fill="none"
          stroke={ink}
          strokeWidth="16"
          strokeLinecap="round"
        />
        <g fill={ink}>
          <circle cx="20" cy="22" r="5" />
          <circle cx="78" cy="78" r="5" />
        </g>
      </>
    ),
  },
  performing_arts: {
    pairIndex: 1,
    draw: (ink, ground) => (
      <>
        <path d="M14 14 H86 V46 C86 72 68 90 50 90 C32 90 14 72 14 46 Z" fill={ink} />
        <g fill={ground}>
          <path d="M28 38 Q36 30 44 38 Q36 44 28 38 Z" />
          <path d="M56 38 Q64 30 72 38 Q64 44 56 38 Z" />
        </g>
        <path
          d="M32 62 Q50 80 68 62"
          fill="none"
          stroke={ground}
          strokeWidth="6"
          strokeLinecap="round"
        />
      </>
    ),
  },
  esports: {
    pairIndex: 15,
    draw: (ink, ground) => (
      <>
        <path
          d="M24 28 H76 C90 28 98 44 94 66 C92 78 84 82 76 76 L66 66 H34 L24 76 C16 82 8 78 6 66 C2 44 10 28 24 28 Z"
          fill={ink}
        />
        <g fill={ground}>
          <rect x="22" y="44" width="20" height="7" rx="2" />
          <rect x="28.5" y="37.5" width="7" height="20" rx="2" />
          <circle cx="68" cy="42" r="4.5" />
          <circle cx="78" cy="52" r="4.5" />
        </g>
      </>
    ),
  },
  other: {
    pairIndex: 9,
    draw: (ink) => (
      <g fill={ink}>
        <circle cx="28" cy="28" r="14" />
        <rect x="58" y="14" width="28" height="28" rx="6" />
        <polygon points="28 58 42 86 14 86" />
        <polygon points="72 56 88 72 72 88 56 72" />
      </g>
    ),
  },
};

export function CategoryTileArt({ category }: { category: CompetitionCategory }): ReactElement {
  const { pairIndex, draw } = TILE_DRAWINGS[category];
  const pair = pairAt(pairIndex);

  return (
    <span className="home-category-art" style={{ background: pair.ground }} aria-hidden="true">
      <svg viewBox="0 0 100 100">{draw(pair.ink, pair.ground)}</svg>
    </span>
  );
}
