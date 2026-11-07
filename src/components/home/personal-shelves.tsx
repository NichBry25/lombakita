"use client";

import { useMemo } from "react";
import { describeDeadlineCountdown } from "@/lib/competitions/deadline-countdown";
import {
  clearRecentlyViewed,
  useInterests,
  useRecentlyViewed,
} from "@/lib/discovery/discovery-store";
import { Shelf } from "./shelf";
import type { ShelfItem } from "./competition-poster-card";

const FOR_YOU_LIMIT = 12;

// The two rows that belong to one visitor: what they opened last and what matches the arenas they
// picked. Both are empty on a first visit and on the server render, so a newcomer sees the shared
// rows below and nothing here until they have opened something or picked an arena.
export function PersonalShelves({ pool }: { pool: ShelfItem[] }) {
  const interests = useInterests();
  const recentlyViewed = useRecentlyViewed();

  // Counted down at render rather than when the item was stored, since an item can sit in history
  // for weeks.
  const recentItems = useMemo<ShelfItem[]>(
    () =>
      recentlyViewed.map((item) => ({
        ...item,
        countdown: describeDeadlineCountdown(item.registrationEndAt),
      })),
    [recentlyViewed],
  );

  const forYouItems = useMemo(
    () =>
      interests.length === 0
        ? []
        : pool
            .filter((item) => item.category !== null && interests.some((c) => c === item.category))
            .slice(0, FOR_YOU_LIMIT),
    [interests, pool],
  );

  if (recentItems.length === 0 && forYouItems.length === 0) return null;

  return (
    <div className="page-section home-personal-shelves">
      <div className="content-shell shelf-stack">
        <Shelf
          eyebrow="Lanjutkan"
          title="Terakhir kamu lihat"
          items={recentItems}
          headerExtra={
            <button type="button" className="shelf-text-action" onClick={clearRecentlyViewed}>
              Hapus riwayat
            </button>
          }
        />
        <Shelf
          eyebrow="Sesuai minatmu"
          title="Untuk kamu"
          items={forYouItems}
          headerExtra={
            <a href="#minat" className="shelf-text-action">
              Ubah minat
            </a>
          }
        />
      </div>
    </div>
  );
}
