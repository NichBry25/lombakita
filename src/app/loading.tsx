import { Skeleton, SkeletonCard } from "@/components/ui";

const CATEGORY_PLACEHOLDERS = [0, 1, 2, 3, 4, 5];
const FEATURED_PLACEHOLDERS = [0, 1, 2];

/**
 * The landing page is the one surface with no archetype: it is a hero band over a category
 * rail over a featured grid. It reuses the live home layout classes so the placeholder holds
 * the same geometry the real page arrives into.
 */
export default function HomeLoading() {
  return (
    <main aria-busy="true" aria-label="Memuat beranda">
      <section className="brand-band home-hero">
        <div className="content-shell home-hero-inner">
          <div className="home-hero-main">
            <div className="home-hero-copy stack-md">
              <Skeleton variant="title" width="full" />
              <Skeleton width="wide" />
              <Skeleton variant="block" />
            </div>
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="content-shell stack-lg">
          <div className="stack-xs">
            <Skeleton variant="eyebrow" />
            <Skeleton variant="title" width="half" />
          </div>
          <div className="home-category-grid">
            {CATEGORY_PLACEHOLDERS.map((index) => (
              <Skeleton key={index} variant="block" />
            ))}
          </div>
        </div>
      </section>

      <section className="page-section">
        <div className="content-shell stack-lg">
          <div className="stack-xs">
            <Skeleton variant="eyebrow" />
            <Skeleton variant="title" width="half" />
          </div>
          <div className="competition-grid">
            {FEATURED_PLACEHOLDERS.map((index) => (
              <SkeletonCard key={index} />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
