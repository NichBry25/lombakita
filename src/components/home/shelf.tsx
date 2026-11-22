"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui";
import { CompetitionPosterCard, type ShelfItem } from "./competition-poster-card";

// A titled, sideways-scrolling row of competitions: the homepage is a stack of these, each one a
// different reason to open something (closing soon, new, your arenas, what you looked at last).
// Touch readers swipe; pointer readers get the arrow pair in the header, which hides itself when
// the whole row already fits.
export function Shelf({
  eyebrow,
  title,
  items,
  action,
  headerExtra,
}: {
  eyebrow?: string;
  title: string;
  items: ShelfItem[];
  action?: { href: string; label: string };
  headerExtra?: ReactNode;
}) {
  const headingId = useId();
  const trackRef = useRef<HTMLUListElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const updateEdges = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    // Absorbs the scroll-snap rest offset left by the track's inline padding.
    const tolerance = 12;
    setAtStart(el.scrollLeft <= tolerance);
    setAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - tolerance);
  }, []);

  useEffect(() => {
    updateEdges();
    window.addEventListener("resize", updateEdges);
    return () => window.removeEventListener("resize", updateEdges);
  }, [updateEdges, items.length]);

  // One press moves a full row's width less one card, so the last card in view stays as the anchor.
  const scrollByPage = (direction: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>(".shelf-slot");
    const step = Math.max(el.clientWidth - (card?.offsetWidth ?? 0), card?.offsetWidth ?? 0);
    el.scrollBy({ left: step * direction, behavior: "smooth" });
  };

  if (items.length === 0) return null;

  const fits = atStart && atEnd;

  return (
    <section className="shelf" aria-labelledby={headingId}>
      <header className="shelf-header">
        <div className="stack-xs">
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h2 id={headingId} className="shelf-title">
            {title}
          </h2>
        </div>
        <div className="shelf-header-actions">
          {headerExtra}
          {action ? (
            <Link href={action.href} className="shelf-see-all">
              {action.label}
              <Icon name="arrow-right" size="sm" />
            </Link>
          ) : null}
          {fits ? null : (
            <span className="shelf-nav">
              <button
                type="button"
                className="shelf-nav-btn"
                data-direction="prev"
                aria-label={`Geser ${title} ke kiri`}
                onClick={() => scrollByPage(-1)}
                disabled={atStart}
              >
                <Icon name="arrow-right" size="sm" />
              </button>
              <button
                type="button"
                className="shelf-nav-btn"
                aria-label={`Geser ${title} ke kanan`}
                onClick={() => scrollByPage(1)}
                disabled={atEnd}
              >
                <Icon name="arrow-right" size="sm" />
              </button>
            </span>
          )}
        </div>
      </header>

      <ul className="shelf-track" ref={trackRef} onScroll={updateEdges}>
        {items.map((item) => (
          <li className="shelf-slot" key={item.id}>
            <CompetitionPosterCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}
