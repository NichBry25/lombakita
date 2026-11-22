"use client";

import { useMemo } from "react";
import { useInterests } from "@/lib/discovery/discovery-store";
import { Shelf } from "./shelf";
import type { ShelfItem } from "./competition-poster-card";

export type CategoryShelfGroup = {
  category: string;
  label: string;
  items: ShelfItem[];
};

// One row per arena that has something open. The server orders them by how much each holds; the
// visitor's own arenas are lifted to the top once they have picked some, keeping that order within
// each half.
export function CategoryShelves({ groups }: { groups: CategoryShelfGroup[] }) {
  const interests = useInterests();

  const ordered = useMemo(() => {
    if (interests.length === 0) return groups;
    const isPicked = (group: CategoryShelfGroup) =>
      interests.some((category) => category === group.category);
    return [...groups.filter(isPicked), ...groups.filter((group) => !isPicked(group))];
  }, [groups, interests]);

  if (ordered.length === 0) return null;

  return (
    <div className="page-section">
      <div className="content-shell shelf-stack">
        {ordered.map((group) => (
          <Shelf
            key={group.category}
            eyebrow="Arena"
            title={group.label}
            items={group.items}
            action={{
              href: `/competitions?category=${group.category}`,
              label: "Lihat semua",
            }}
          />
        ))}
      </div>
    </div>
  );
}
