import { useMemo, useSyncExternalStore } from "react";
import type { CompetitionCategory } from "@/server/db/schema";
import { COMPETITION_CATEGORY_VALUES } from "@/lib/competitions/categories";

// What the homepage remembers about one visitor so it can greet them with their own rows: the arenas
// they picked and the competitions they opened recently. Both live in this browser only. The
// homepage HTML is cached and identical for every visitor, so anything personal has to be added
// after it arrives, and nothing here is worth an account or a database row.
//
// Every read and write tolerates storage being unavailable (private windows, blocked site data):
// the rows simply stay empty and the page reads as it does for a first visit.

const INTERESTS_KEY = "lombakita-interests";
const RECENTLY_VIEWED_KEY = "lombakita-recently-viewed";

// Same-tab writes do not fire the `storage` event, so writers announce them on this one.
const CHANGE_EVENT = "lombakita-discovery-change";

export const RECENTLY_VIEWED_LIMIT = 12;

export type RecentlyViewedItem = {
  id: string;
  slug: string;
  institutionSlug: string;
  title: string;
  institutionName: string;
  category: string | null;
  registrationEndAt: string | null;
};

const readStoredText = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStoredText = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
};

// The snapshot is the stored text itself: a string compares by value, so a component re-renders
// only when the stored text changed. The server snapshot is null, which is also what the first
// client render sees, so the shared HTML hydrates without a mismatch and the personal rows appear
// right after.
const useStoredText = (key: string): string | null =>
  useSyncExternalStore(
    subscribe,
    () => readStoredText(key),
    () => null,
  );

const parseJsonArray = (raw: string | null): unknown[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const isCategory = (value: unknown): value is CompetitionCategory =>
  (COMPETITION_CATEGORY_VALUES as readonly unknown[]).includes(value);

// Stored text is whatever an older version of the page, or a hand-edited devtools session, left
// behind, so anything that is not a known category is dropped rather than trusted.
export const parseInterests = (raw: string | null): CompetitionCategory[] => [
  ...new Set(parseJsonArray(raw).filter(isCategory)),
];

const isNullableString = (value: unknown) => value === null || typeof value === "string";

const isRecentlyViewedItem = (value: unknown): value is RecentlyViewedItem => {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.slug === "string" &&
    typeof item.institutionSlug === "string" &&
    typeof item.title === "string" &&
    typeof item.institutionName === "string" &&
    isNullableString(item.category) &&
    isNullableString(item.registrationEndAt)
  );
};

export const parseRecentlyViewed = (raw: string | null): RecentlyViewedItem[] =>
  parseJsonArray(raw).filter(isRecentlyViewedItem).slice(0, RECENTLY_VIEWED_LIMIT);

export function useInterests(): CompetitionCategory[] {
  const raw = useStoredText(INTERESTS_KEY);
  return useMemo(() => parseInterests(raw), [raw]);
}

export function useRecentlyViewed(): RecentlyViewedItem[] {
  const raw = useStoredText(RECENTLY_VIEWED_KEY);
  return useMemo(() => parseRecentlyViewed(raw), [raw]);
}

export function toggleInterest(category: CompetitionCategory) {
  const current = parseInterests(readStoredText(INTERESTS_KEY));
  const next = current.includes(category)
    ? current.filter((value) => value !== category)
    : [...current, category];
  writeStoredText(INTERESTS_KEY, JSON.stringify(next));
}

export function clearInterests() {
  writeStoredText(INTERESTS_KEY, JSON.stringify([]));
}

// Most recent first. Opening a competition again moves it back to the front instead of listing it
// twice.
export function recordRecentlyViewed(item: RecentlyViewedItem) {
  const current = parseRecentlyViewed(readStoredText(RECENTLY_VIEWED_KEY));
  const next = [item, ...current.filter((entry) => entry.id !== item.id)].slice(
    0,
    RECENTLY_VIEWED_LIMIT,
  );
  writeStoredText(RECENTLY_VIEWED_KEY, JSON.stringify(next));
}

export function clearRecentlyViewed() {
  writeStoredText(RECENTLY_VIEWED_KEY, JSON.stringify([]));
}
