import type { Metadata } from "next";
import { ButtonLink, Icon } from "@/components/ui";
import { CompetitionSearchForm } from "@/app/competitions/competition-search-form";
import { INDEXABLE_ROBOTS } from "@/config/indexable-routes";
import { MemphisHeroArt } from "@/components/home/memphis-hero-art";
import { FeaturedCarousel } from "@/components/home/featured-carousel";
import { listFeaturedCompetitions } from "@/server/competitions/competition-public-service";
import { logger } from "@/lib/logger";
import type { PublicCompetitionItem } from "@/server/competitions/competition-public-service";

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

const HERO_ART_START_LAYOUT_SEED = 0x9e3779b1;

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
        <div className="home-hero-inner">
          <MemphisHeroArt layoutSeed={HERO_ART_START_LAYOUT_SEED} />

          <div className="home-hero-main" data-hero-clearing>
            <div className="home-hero-copy stack-md">
              <h1>
                Cari kompetisi, cek tenggat, dan daftar dari{" "}
                <span className="lime-marker">satu tempat</span>
              </h1>
            </div>

            <CompetitionSearchForm params={{}} variant="home" />
          </div>
        </div>
      </section>

      <div className="home-marquee" aria-hidden="true">
        <div className="home-marquee-track">
          {MARQUEE_ITEMS.map((word, index) => (
            <span key={index}>{word}</span>
          ))}
        </div>
      </div>

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
              <h2>Buat ruang kerja institusi untuk menerbitkan kompetisi</h2>
            </div>
            <ButtonLink href="/recruiter-dashboard" variant="primary" size="lg" prefetch={false}>
              Buka ruang kerja
              <Icon name="arrow-right" size="md" />
            </ButtonLink>
          </div>
        </div>
      </section>
    </main>
  );
}
