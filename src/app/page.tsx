import Link from "next/link";
import { ButtonLink, Icon } from "@/components/ui";
import { MemphisHeroArt } from "@/components/home/memphis-hero-art";
import { FeaturedCarousel } from "@/components/home/featured-carousel";
import { listFeaturedCompetitions } from "@/server/competitions/competition-public-service";
import { logger } from "@/lib/logger";
import type { PublicCompetitionItem } from "@/server/competitions/competition-public-service";

// Featured placement is ops-managed and changes rarely (Step 5.5), so a short staleness
// window is acceptable — ISR avoids a DB round trip on every request to the highest-traffic
// page. The render has no session-dependent content (see pre-flight audit, W0), so caching it
// is safe: identical HTML for every visitor.
export const revalidate = 300;

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

export default async function HomePage() {
  const featuredCompetitions = await loadFeaturedCompetitionsOrEmpty();

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

      <section className="page-section">
        <div className="content-shell stack-lg">
          <header className="home-section-header">
            <div className="stack-xs">
              <p className="eyebrow">Jelajahi berdasarkan minat</p>
              <h2 className="section-title">Pilih arenamu</h2>
            </div>
          </header>

          <div className="home-category-grid">
            {DISCOVERY_CATEGORIES.map((category) => (
              <Link
                className="home-category-card"
                data-category={category.value}
                href="/competitions"
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
        </div>
      </section>

      {featuredCompetitions.length > 0 ? (
        <section className="page-section">
          <div className="content-shell stack-lg">
            <FeaturedCarousel items={featuredCompetitions} />
          </div>
        </section>
      ) : null}

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
