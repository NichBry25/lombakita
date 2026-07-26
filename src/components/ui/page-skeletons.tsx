import type { ReactNode } from "react";
import { joinClassNames } from "./class-names";
import { Skeleton, SkeletonCard } from "./skeleton";

/**
 * Route-level loading skeletons, shaped by what a page *does* rather than by which page it is.
 *
 * Each archetype composes the same layout classes as the real pages it stands in for
 * (`page-heading`, `content-section`, `competition-grid`, `detail-layout`), so the placeholder
 * geometry tracks the live layout instead of drifting from it whenever the page changes.
 *
 * Pick the archetype that matches the page's job: a form page gets `FormPageSkeleton`, a card
 * listing gets `ListPageSkeleton`, and so on. See docs/product/ui-preferences.md §14.
 */

type PageSkeletonProps = {
  label?: string;
  className?: string;
};

function countTo(total: number) {
  return Array.from({ length: total }, (_, index) => index);
}

function SkeletonPage({ label, className, children }: PageSkeletonProps & { children: ReactNode }) {
  return (
    <main
      className={joinClassNames("page-shell app-page", className)}
      aria-busy="true"
      aria-label={label}
    >
      {children}
    </main>
  );
}

function SkeletonHeading({
  withEyebrow = false,
  withActions = false,
}: {
  withEyebrow?: boolean;
  withActions?: boolean;
}) {
  return (
    <header className="page-heading">
      <div className="page-heading-main">
        {withEyebrow ? <Skeleton variant="eyebrow" /> : null}
        <Skeleton variant="title" />
        <Skeleton width="wide" />
      </div>
      {withActions ? (
        <div className="page-heading-actions">
          <Skeleton variant="button" />
        </div>
      ) : null}
    </header>
  );
}

function SkeletonFilterRow({ chips = 3 }: { chips?: number }) {
  return (
    <div className="skeleton-filter-row">
      {countTo(chips).map((index) => (
        <Skeleton key={index} variant="chip" />
      ))}
    </div>
  );
}

function SkeletonTextLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className="stack-xs">
      {countTo(lines).map((index) => (
        <Skeleton key={index} width={index === lines - 1 ? "half" : "full"} />
      ))}
    </div>
  );
}

/** Anything whose job is filling in fields: create, edit, settings, onboarding, upload. */
export function FormPageSkeleton({
  label = "Memuat formulir",
  className,
  fields = 5,
}: PageSkeletonProps & { fields?: number }) {
  return (
    <SkeletonPage label={label} className={className}>
      <SkeletonHeading />
      <section className="content-section">
        {countTo(fields).map((index) => (
          <div key={index} className="stack-xs">
            <Skeleton width="narrow" />
            <Skeleton variant="block" />
          </div>
        ))}
        <div className="skeleton-actions">
          <Skeleton variant="button" />
          <Skeleton variant="button" />
        </div>
      </section>
    </SkeletonPage>
  );
}

/** Card listings: discovery, saved items, competition collections, result collections. */
export function ListPageSkeleton({
  label = "Memuat daftar",
  className,
  cards = 6,
  withFilters = true,
}: PageSkeletonProps & { cards?: number; withFilters?: boolean }) {
  return (
    <SkeletonPage label={label} className={className}>
      <SkeletonHeading withActions />
      {withFilters ? <SkeletonFilterRow chips={4} /> : null}
      <div className="competition-grid">
        {countTo(cards).map((index) => (
          <SkeletonCard key={index} />
        ))}
      </div>
    </SkeletonPage>
  );
}

/** One subject in depth: a competition, a registration, a profile, a submission. */
export function DetailPageSkeleton({
  label = "Memuat detail",
  className,
  withRail = true,
}: PageSkeletonProps & { withRail?: boolean }) {
  return (
    <SkeletonPage label={label} className={className}>
      <SkeletonHeading withEyebrow withActions />
      <div className={withRail ? "detail-layout" : undefined}>
        <div className="detail-main stack-lg">
          <Skeleton variant="media" />
          <SkeletonTextLines lines={4} />
          <SkeletonTextLines lines={3} />
        </div>
        {withRail ? (
          <aside className="content-section stack-sm">
            <Skeleton variant="chip" />
            <SkeletonTextLines lines={3} />
            <Skeleton variant="button" />
          </aside>
        ) : null}
      </div>
    </SkeletonPage>
  );
}

/** Row-oriented reading: review queues, member lists, participants, audit logs, the inbox. */
export function TablePageSkeleton({
  label = "Memuat data",
  className,
  rows = 6,
  columns = 4,
  withFilters = true,
}: PageSkeletonProps & { rows?: number; columns?: number; withFilters?: boolean }) {
  return (
    <SkeletonPage label={label} className={className}>
      <SkeletonHeading withActions />
      <section className="content-section">
        {withFilters ? <SkeletonFilterRow /> : null}
        <div className="skeleton-table">
          {countTo(rows).map((rowIndex) => (
            <div key={rowIndex} className="skeleton-table-row">
              {countTo(columns).map((columnIndex) => (
                <Skeleton key={columnIndex} />
              ))}
            </div>
          ))}
        </div>
      </section>
    </SkeletonPage>
  );
}

/** Landing surfaces that summarise several areas at once: dashboards and workspace hubs. */
export function DashboardPageSkeleton({
  label = "Memuat dasbor",
  className,
  stats = 3,
  sections = 2,
}: PageSkeletonProps & { stats?: number; sections?: number }) {
  return (
    <SkeletonPage label={label} className={className}>
      <SkeletonHeading withActions />
      <div className="skeleton-stat-grid">
        {countTo(stats).map((index) => (
          <div key={index} className="content-section stack-xs">
            <Skeleton width="narrow" />
            <Skeleton variant="title" />
          </div>
        ))}
      </div>
      {countTo(sections).map((index) => (
        <section key={index} className="content-section stack-sm">
          <Skeleton variant="title" width="narrow" />
          <SkeletonTextLines lines={3} />
        </section>
      ))}
    </SkeletonPage>
  );
}

/** Short single-purpose pages: notices, confirmations, auth interstitials. */
export function PageShellSkeleton({ label = "Memuat halaman", className }: PageSkeletonProps) {
  return (
    <SkeletonPage label={label} className={className}>
      <SkeletonHeading />
      <section className="content-section">
        <SkeletonTextLines lines={3} />
        <Skeleton variant="button" />
      </section>
    </SkeletonPage>
  );
}
