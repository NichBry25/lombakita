"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ButtonLink, Icon, IconButton } from "@/components/ui";
import {
  CompetitionCard,
  type CompetitionCardItem,
} from "@/components/competitions/competition-card";

// Featured competitions carousel with side-flanking prev/next controls.
export function FeaturedCarousel({ items }: { items: CompetitionCardItem[] }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const [fitsWithoutScrolling, setFitsWithoutScrolling] = useState(false);

  const updateEdges = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    setFitsWithoutScrolling(el.scrollWidth <= el.clientWidth);
    // Tolerance absorbs the scroll-snap rest offset from the rail's inline padding.
    const tolerance = 12;
    setAtStart(el.scrollLeft <= tolerance);
    setAtEnd(el.scrollLeft >= el.scrollWidth - el.clientWidth - tolerance);
  }, []);

  useEffect(() => {
    updateEdges();
    window.addEventListener("resize", updateEdges);
    return () => window.removeEventListener("resize", updateEdges);
  }, [updateEdges]);

  const scrollByStep = (direction: 1 | -1) => {
    const el = viewportRef.current;
    if (!el) return;
    const slides = el.querySelectorAll<HTMLElement>(".featured-carousel-slide");
    const first = slides[0];
    const second = slides[1];
    const step =
      first && second
        ? second.offsetLeft - first.offsetLeft
        : (first?.offsetWidth ?? el.clientWidth);
    el.scrollBy({ left: step * direction, behavior: "smooth" });
  };

  return (
    <>
      <header className="stack-xs">
        <div className="home-section-header featured-section-header">
          <h2 className="section-title">Kompetisi unggulan</h2>
          <ButtonLink
            href="/competitions"
            variant="link"
            size="sm"
            className="featured-view-all"
            aria-label="Lihat semua kompetisi"
          >
            <span className="featured-view-all-text">Lihat semua</span>
            <span className="featured-view-all-arrow">
              <Icon name="arrow-right" size="sm" />
            </span>
          </ButtonLink>
        </div>
      </header>

      <div
        className="featured-carousel-wrap"
        data-has-arrows={fitsWithoutScrolling ? undefined : "true"}
      >
        {fitsWithoutScrolling ? null : (
          <IconButton
            icon="arrow-left"
            variant="outline"
            label="Kompetisi sebelumnya"
            className="featured-nav-btn"
            data-direction="prev"
            onClick={() => scrollByStep(-1)}
            disabled={atStart}
          />
        )}

        <div className="featured-carousel" ref={viewportRef} onScroll={updateEdges}>
          {items.map((competition) => (
            <div className="featured-carousel-slide" key={competition.id}>
              <CompetitionCard competition={competition} />
            </div>
          ))}
        </div>

        {fitsWithoutScrolling ? null : (
          <IconButton
            icon="arrow-right"
            variant="outline"
            label="Kompetisi berikutnya"
            className="featured-nav-btn"
            data-direction="next"
            onClick={() => scrollByStep(1)}
            disabled={atEnd}
          />
        )}
      </div>
    </>
  );
}
