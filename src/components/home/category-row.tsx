"use client";

import Link from "next/link";
import { competitionsHref } from "@/app/competitions/search-params";
import { CategoryTileArt } from "@/components/home/category-tile-art";
import { useDragScroll } from "@/components/home/use-drag-scroll";
import {
  COMPETITION_CATEGORY_LABELS,
  COMPETITION_CATEGORY_VALUES,
} from "@/lib/competitions/categories";
import type { CompetitionCategory } from "@/server/db/schema";

const PHONE_CATEGORIES: readonly CompetitionCategory[] = [
  "olympiad",
  "scientific_writing",
  "essay",
  "debate",
  "quiz",
  "business",
  "hackathon",
  "design",
  "infographics",
];

const OTHER_CATEGORIES = COMPETITION_CATEGORY_VALUES.filter(
  (category) => !PHONE_CATEGORIES.includes(category),
);

const ROW_ORDER = [...PHONE_CATEGORIES, ...OTHER_CATEGORIES];

// Every category in one row that scrolls sideways. A mouse drags it, a trackpad swipes it and a
// phone scrolls it natively. On a phone the row becomes a 3 by 3 block of PHONE_CATEGORIES.
export function CategoryRow() {
  const { rowRef, isDragging, startDrag, swallowClickAfterDrag } =
    useDragScroll<HTMLUListElement>();

  return (
    <div className="home-category-frame">
      <ul
        className="home-category-row"
        ref={rowRef}
        data-dragging={isDragging || undefined}
        onPointerDown={startDrag}
        onClickCapture={swallowClickAfterDrag}
      >
        {ROW_ORDER.map((category) => (
          <li
            className="home-category-item"
            data-phone-hidden={PHONE_CATEGORIES.includes(category) ? undefined : true}
            key={category}
          >
            <Link
              className="home-category-tile"
              href={competitionsHref({}, { category })}
              draggable={false}
            >
              <CategoryTileArt category={category} />
              <span className="home-category-label">{COMPETITION_CATEGORY_LABELS[category]}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
