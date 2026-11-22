"use client";

import { useSyncExternalStore } from "react";
import { formatDateIn, formatWib, type DateFormatName } from "@/lib/dates/date-format";

const subscribeToNothing = () => () => {};

// The server cannot know the reader's zone, so the server HTML and hydration show WIB, and the
// browser then shows the device's own time. useSyncExternalStore makes that switch without a
// hydration mismatch.
export function LocalDate({ value, format }: { value: Date | string; format: DateFormatName }) {
  const date = new Date(value);
  const isValid = !Number.isNaN(date.getTime());
  const text = useSyncExternalStore(
    subscribeToNothing,
    () => formatDateIn(date, format, undefined),
    () => formatWib(date, format),
  );
  if (!isValid) return <>—</>;
  return <time dateTime={date.toISOString()}>{text}</time>;
}
