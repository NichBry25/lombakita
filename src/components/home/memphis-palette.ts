export const PALM = "#14453d";
export const PALM_INK = "#0e332d";
export const TANGERINE = "#f4632a";
export const TERRACOTTA = "#c6491b";
export const PAPER = "#fbf6eb";
export const LIME = "#d0f05e";
export const LIME_DEEP = "#9db53c";
export const PEACH = "#ffd3b0";
export const BLUSH = "#ffe9da";
export const MIST = "#e4ede4";

/*
 * Curated ground/ink pairs, drawn only from the brand book palette (Brand Book
 * v2 — docs/product/ui-preferences.md). Every pair keeps the motif legible on
 * its ground.
 */
export type ColorPair = { ground: string; ink: string };
export const PAIRS: ColorPair[] = [
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

const FALLBACK_PAIR: ColorPair = { ground: LIME, ink: PALM };

export function pairAt(index: number): ColorPair {
  return PAIRS[index % PAIRS.length] ?? FALLBACK_PAIR;
}
