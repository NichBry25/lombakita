"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ButtonLink, Icon, IconButton } from "@/components/ui";
import { LocalDate } from "@/components/ui/local-date";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";

type FeaturedItem = {
  id: string;
  slug: string;
  title: string;
  category: string | null;
  mode: string | null;
  registrationEndAt: Date | string | null;
  institutionSlug: string;
  institutionName: string;
};

function toDate(value: Date | string | null) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function resolveRegistrationStatus(value: Date | string | null) {
  const date = toDate(value);
  if (!date) return { value: "open", label: "Dibuka" } as const;
  const millisecondsRemaining = date.getTime() - Date.now();
  if (millisecondsRemaining <= 0) return { value: "closed", label: "Ditutup" } as const;
  if (millisecondsRemaining < 7 * 24 * 60 * 60 * 1000) {
    return { value: "closing", label: "Segera ditutup" } as const;
  }
  return { value: "open", label: "Dibuka" } as const;
}

// Featured competitions carousel with side-flanking prev/next controls.
export function FeaturedCarousel({ items }: { items: FeaturedItem[] }) {
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
          {items.map((competition) => {
            const detailPath = `/competitions/${competition.institutionSlug}/${competition.slug}`;
            const registrationStatus = resolveRegistrationStatus(competition.registrationEndAt);
            const categoryLabel = competition.category
              ? getCompetitionCategoryLabel(competition.category)
              : "Kompetisi";
            return (
              <article className="competition-card featured-carousel-slide" key={competition.id}>
                <Link
                  href={detailPath}
                  className="competition-cover"
                  data-category={competition.category ?? "other"}
                  aria-label={`Buka ${competition.title}`}
                >
                  <span className="competition-cover-icon" aria-hidden="true">
                    <Icon name="trophy" size="lg" />
                  </span>
                  <span className="competition-cover-label">{categoryLabel}</span>
                </Link>

                <div className="competition-card-body">
                  <div className="competition-card-badges">
                    {competition.mode ? (
                      <span className="status-badge">
                        {getCompetitionModeLabel(competition.mode)}
                      </span>
                    ) : null}
                  </div>

                  <div className="stack-xs">
                    <Link href={detailPath} className="competition-title-link">
                      {competition.title}
                    </Link>
                    <p className="competition-organizer">{competition.institutionName}</p>
                  </div>

                  <div className="competition-card-footer">
                    <span className="status-badge" data-status={registrationStatus.value}>
                      {registrationStatus.label} ·{" "}
                      {competition.registrationEndAt ? (
                        <LocalDate value={competition.registrationEndAt} format="shortDate" />
                      ) : (
                        "Tanpa batas waktu"
                      )}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
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
