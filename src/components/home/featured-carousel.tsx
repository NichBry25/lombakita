"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ButtonLink, Icon } from "@/components/ui";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";

type FeaturedItem = {
  id: string;
  slug: string;
  title: string;
  description: string;
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

function formatDeadline(value: Date | string | null) {
  const date = toDate(value);
  if (!date) return "Tanpa batas waktu";
  return date.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
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

function truncateDescription(description: string) {
  return description.length > 140 ? `${description.slice(0, 140)}…` : description;
}

// Featured competitions carousel with side-flanking prev/next controls.
export function FeaturedCarousel({ items }: { items: FeaturedItem[] }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const updateEdges = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
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
        <p className="eyebrow">Pilihan Editor</p>
        <div className="home-section-header">
          <h2 className="section-title">Kompetisi ternama</h2>
          <ButtonLink
            href="/competitions"
            variant="primary"
            size="sm"
            className="featured-view-all"
          >
            Semua
            <Icon name="arrow-right" size="sm" />
          </ButtonLink>
        </div>
      </header>

      <div className="featured-carousel-wrap">
        <button
          type="button"
          className="featured-nav-btn"
          data-direction="prev"
          aria-label="Kompetisi sebelumnya"
          onClick={() => scrollByStep(-1)}
          disabled={atStart}
        >
          <Icon name="arrow-right" size="md" />
        </button>

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
                    <span className="status-badge" data-status="featured">
                      Pilihan Editor
                    </span>
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

                  {competition.description ? (
                    <p className="competition-description">
                      {truncateDescription(competition.description)}
                    </p>
                  ) : null}

                  <div className="competition-card-footer">
                    <span className="status-badge" data-status={registrationStatus.value}>
                      {registrationStatus.label} · {formatDeadline(competition.registrationEndAt)}
                    </span>
                    <span className="competition-card-arrow" aria-hidden="true">
                      <Icon name="arrow-right" size="md" />
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <button
          type="button"
          className="featured-nav-btn"
          data-direction="next"
          aria-label="Kompetisi berikutnya"
          onClick={() => scrollByStep(1)}
          disabled={atEnd}
        >
          <Icon name="arrow-right" size="md" />
        </button>
      </div>
    </>
  );
}
