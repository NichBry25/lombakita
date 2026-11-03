"use client";

import { useEffect } from "react";
import { recordRecentlyViewed, type RecentlyViewedItem } from "@/lib/discovery/discovery-store";

// Opening a competition adds it to this browser's "Terakhir kamu lihat" row on the homepage, the
// way a streaming service keeps what you were watching at the front. Renders nothing.
export function RecordRecentlyViewed({ item }: { item: RecentlyViewedItem }) {
  useEffect(() => {
    recordRecentlyViewed(item);
  }, [item]);

  return null;
}
