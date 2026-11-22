import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink, Icon } from "@/components/ui";
import { INDEXABLE_ROBOTS } from "@/config/indexable-routes";
import { MemphisHeroArt } from "@/components/home/memphis-hero-art";
import { FeaturedCarousel } from "@/components/home/featured-carousel";
import { Shelf } from "@/components/home/shelf";
import { PersonalShelves } from "@/components/home/personal-shelves";
import { InterestPicker } from "@/components/home/interest-picker";
import { CategoryShelves, type CategoryShelfGroup } from "@/components/home/category-shelves";
import type { ShelfItem } from "@/components/home/competition-poster-card";
import {
  listFeaturedCompetitions,
  listPublicCompetitions,
} from "@/server/competitions/competition-public-service";
import {
  COMPETITION_CATEGORY_VALUES,
  getCompetitionCategoryLabel,
} from "@/lib/competitions/categories";
import { describeRegistrationCountdown } from "@/lib/competitions/deadline-countdown";
import { logger } from "@/lib/logger";
import type {
  PublicCompetitionItem,
  PublicListingFilters,
} from "@/server/competitions/competition-public-service";

// Featured placement is ops-managed and changes rarely, so a short staleness
// window is acceptable — ISR avoids a DB round trip on every request to the highest-traffic
// page. The render has no session-dependent content, so caching it
// is safe: identical HTML for every visitor.
export const revalidate = 300;

// Title and description come from the root layout, which already states what Lombakita is for the
// landing page's benefit. Declared here only to opt the page into indexing and to give the link
// preview an explicit subject.
export const metadata: Metadata = {
  robots: INDEXABLE_ROBOTS,
  alternates: { canonical: "/" },
  openGraph: {
    title: "Lombakita",
    description:
      "Temukan kompetisi, beasiswa, dan magang di Indonesia. Terbuka untuk pelajar, mahasiswa, lulusan baru, dan profesional.",
    url: "/",
    type: "website",
  },
};

const DISCOVERY_CATEGORIES = [
  {
    value: "hackathon",
    label: "Hackathon",
    detail: "Sprint coding, produk digital, dan inovasi",
  },
  { value: "business", label: "Business", detail: "Business case, rencana bisnis, dan pitching" },
  {
    value: "scientific_writing",
    label: "Karya tulis ilmiah",
    detail: "Riset, karya ilmiah, dan olimpiade",
  },
  {
    value: "design",
    label: "UI/UX & desain",
    detail: "Desain antarmuka dan karya visual",
  },
] as const;

const TRUST_MARKERS = [
  "Penyelenggara terverifikasi",
  "Tenggat di setiap kartu",
  "Daftar tanpa pindah situs",
] as const;

const MARQUEE_WORDS = ["Temukan", "Daftar", "Berkarya", "Menang"] as const;
// One half, repeated enough to overflow the ribbon even on a wide monitor, then doubled
// so the translateX(-50%) loop lands the second half exactly over the first — no blank run.
const MARQUEE_HALF = Array.from({ length: 9 }, () => MARQUEE_WORDS).flat();
const MARQUEE_ITEMS = [...MARQUEE_HALF, ...MARQUEE_HALF];

// Featured placement is a decorative rail, not core to the page. A fetch failure (e.g. the DB
// is unreachable) degrades to no rail rather than taking down the whole public homepage — but
// the failure is still recorded so a broken featured system is never hidden.
const loadFeaturedCompetitionsOrEmpty = async (): Promise<PublicCompetitionItem[]> => {
  try {
    return await listFeaturedCompetitions(4);
  } catch (error) {
    logger.error("home.featured-competitions.load-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
};

const SHELF_LIMIT = 12;

// The newest live competitions, read once and cut three ways: the "Baru tayang" row, one row per
// arena, and the visitor's own "Untuk kamu" row, which is picked from it in the browser. The
// listing's default status keeps every competition whose registration has not closed.
const POOL_LIMIT = 50;

// Each row is decorative in the same way the featured rail is: a failure empties that row and is
// logged, and the rest of the homepage still renders.
const loadShelfOrEmpty = async (
  shelf: string,
  filters: PublicListingFilters,
): Promise<PublicCompetitionItem[]> => {
  try {
    return (await listPublicCompetitions(filters)).data;
  } catch (error) {
    logger.error("home.shelf.load-failed", {
      shelf,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
};

// Counted down here, at render, so every visitor of this cached page sees the same phrase and the
// client rows hydrate without recomputing it.
const toShelfItem = (competition: PublicCompetitionItem, now: Date): ShelfItem => ({
  id: competition.id,
  slug: competition.slug,
  institutionSlug: competition.institutionSlug,
  title: competition.title,
  institutionName: competition.institutionName,
  category: competition.category,
  countdown: describeRegistrationCountdown(
    competition.registrationStartAt,
    competition.registrationEndAt,
    now,
  ),
});

// Fullest arena first; ties keep the category order the filters use.
const groupByCategory = (items: ShelfItem[]): CategoryShelfGroup[] =>
  COMPETITION_CATEGORY_VALUES.map((category) => ({
    category,
    label: getCompetitionCategoryLabel(category),
    items: items.filter((item) => item.category === category).slice(0, SHELF_LIMIT),
  }))
    .filter((group) => group.items.length > 0)
    .sort((a, b) => b.items.length - a.items.length);

export default async function HomePage() {
  const [featuredCompetitions, closingSoonCompetitions, poolCompetitions] = await Promise.all([
    loadFeaturedCompetitionsOrEmpty(),
    loadShelfOrEmpty("closing-soon", {
      status: "closing",
      sort: "deadline_asc",
      limit: SHELF_LIMIT,
    }),
    loadShelfOrEmpty("pool", { sort: "created_desc", limit: POOL_LIMIT }),
  ]);

  const now = new Date();
  const closingSoon = closingSoonCompetitions.map((competition) => toShelfItem(competition, now));
  const pool = poolCompetitions.map((competition) => toShelfItem(competition, now));
  const categoryGroups = groupByCategory(pool);
  const catalogEmpty = pool.length === 0;

  return (
    <main>
      <section className="brand-band home-hero">
        <div className="content-shell home-hero-inner">
          <div className="home-hero-main">
            <div className="home-hero-copy stack-md">
              <h1>
                Temukan kompetisi yang <span className="lime-marker">tepat</span> untuk langkah
                berikutmu.
              </h1>
              <p className="home-hero-lead">
                Jelajahi kompetisi dari penyelenggara yang bisa kamu percaya.
              </p>
            </div>

            <Link href="/competitions" className="glass-focus home-search-entry">
              <span className="home-search-icon" aria-hidden="true">
                <Icon name="search" size="lg" />
              </span>
              <span className="home-search-copy">
                <span className="home-search-label">Cari kompetisi</span>
                <span>Nama, kategori, atau penyelenggara</span>
              </span>
              <span className="ui-button" data-variant="primary" data-size="lg">
                Mulai mencari
                <Icon name="arrow-right" size="md" />
              </span>
            </Link>

            <div className="home-trust-row" aria-label="Keunggulan penemuan peluang">
              {TRUST_MARKERS.map((marker) => (
                <span key={marker}>
                  <Icon name="check" size="sm" />
                  {marker}
                </span>
              ))}
            </div>
          </div>

          <MemphisHeroArt />
        </div>
      </section>

      <div className="home-marquee" aria-hidden="true">
        <div className="home-marquee-track">
          {MARQUEE_ITEMS.map((word, index) => (
            <span key={index}>{word}</span>
          ))}
        </div>
      </div>

      <PersonalShelves pool={pool} />

      {featuredCompetitions.length > 0 ? (
        <section className="page-section">
          <div className="content-shell stack-lg">
            <FeaturedCarousel items={featuredCompetitions} />
          </div>
        </section>
      ) : null}

      {closingSoon.length > 0 || pool.length > 0 ? (
        <div className="page-section">
          <div className="content-shell shelf-stack">
            <Shelf
              eyebrow="Jangan sampai terlewat"
              title="Segera ditutup"
              items={closingSoon}
              action={{
                href: "/competitions?status=closing&sort=deadline_asc",
                label: "Lihat semua",
              }}
            />
            <Shelf
              eyebrow="Baru tayang"
              title="Kompetisi terbaru"
              items={pool.slice(0, SHELF_LIMIT)}
              action={{ href: "/competitions?sort=created_desc", label: "Lihat semua" }}
            />
          </div>
        </div>
      ) : null}

      <CategoryShelves groups={categoryGroups} />

      <section className="page-section">
        <div className="content-shell stack-lg">
          <header className="home-section-header">
            <div className="stack-xs">
              <p className="eyebrow">Jelajahi berdasarkan minat</p>
              <h2 className="section-title">Pilih arenamu</h2>
            </div>
          </header>

          {catalogEmpty ? (
            <p className="home-catalog-note">
              Kompetisi pertama sedang dikurasi bersama penyelenggara. Tandai minatmu sekarang, dan
              berandamu akan tersusun sendiri begitu kompetisinya tayang.
            </p>
          ) : null}

          <div className="home-category-grid">
            {DISCOVERY_CATEGORIES.map((category) => (
              <Link
                className="home-category-card"
                data-category={category.value}
                href={`/competitions?category=${category.value}`}
                key={category.label}
              >
                <span className="home-category-icon" aria-hidden="true">
                  <Icon name="trophy" size="md" />
                </span>
                <div className="stack-xs home-category-copy">
                  <span className="home-category-label">{category.label}</span>
                  <h3>{category.label}</h3>
                  <p>{category.detail}</p>
                </div>
              </Link>
            ))}
          </div>

          <InterestPicker catalogEmpty={catalogEmpty} />
        </div>
      </section>

      <section className="page-section">
        <div className="content-shell">
          <div className="brand-band home-organizer-cta">
            <div className="stack-sm">
              <p className="eyebrow">Untuk penyelenggara</p>
              <h2>Bangun ruang kompetisi yang dipercaya peserta.</h2>
            </div>
            <ButtonLink href="/institution/create" variant="secondary" size="lg" prefetch={false}>
              Buka ruang kerja
              <Icon name="arrow-right" size="md" />
            </ButtonLink>
          </div>
        </div>
      </section>
    </main>
  );
}
