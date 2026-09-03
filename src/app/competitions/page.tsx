import type { Metadata } from "next";
import { ButtonLink, Icon, Pagination } from "@/components/ui";
import { CompetitionCard } from "@/components/competitions/competition-card";
import { listPublicCompetitions } from "@/server/competitions/competition-public-service";
import { CompetitionFilterBar } from "./competition-filter-bar";
import { CompetitionSearchForm } from "./competition-search-form";
import {
  competitionsHref,
  readCompetitionSearchParams,
  type RawCompetitionSearchParams,
} from "./search-params";

export const metadata: Metadata = {
  title: "Kompetisi · Lombakita",
  description:
    "Jelajahi kompetisi yang sedang dibuka di Indonesia. Saring berdasarkan kategori, mode, status, dan ukuran tim.",
};

/**
 * The public competition listing, rendered on the server.
 *
 * It reads its filters from the query string and calls the listing service directly, so the
 * competitions are in the HTML the server sends. The previous version fetched them from
 * `/api/v1/competitions` inside an effect after hydration, which meant a reader without
 * JavaScript, and any crawler that does not run it, got six skeleton cards and nothing else,
 * permanently. The API route stays where it is for other callers.
 *
 * The search box is a plain GET form and the pagination is plain links, so both work in that same
 * no-JavaScript case. The filter dropdowns are custom listboxes and do need JavaScript to open,
 * but the filtered URLs they produce are answered by the server like any other.
 *
 * THIS SEGMENT DELIBERATELY HAS NO `loading.tsx`. A route-level Suspense boundary makes Next flush
 * the skeleton into the shell and stream the listing into a hidden element that only a script can
 * reveal, which puts a reader without JavaScript back in front of a permanent placeholder. Every
 * navigation this page starts therefore carries its own pending signal, on the control that
 * started it: the search button spins through its transition, the filter row spins through
 * its own, and each pagination link spins from `useLinkStatus`.
 */
export default async function PublicCompetitionsPage({
  searchParams,
}: {
  searchParams: Promise<RawCompetitionSearchParams>;
}) {
  const params = readCompetitionSearchParams(await searchParams);
  const page = params.page ? Number.parseInt(params.page, 10) : 1;

  const result = await listPublicCompetitions({
    q: params.q,
    category: params.category,
    mode: params.mode,
    status: params.status,
    teamSize: params.teamSize,
    sort: params.sort,
    page,
  });

  const { data: competitions, meta } = result;

  return (
    <main>
      <section className="brand-band listing-hero">
        <div className="content-shell listing-hero-inner">
          <div className="stack-sm listing-heading">
            <h1>Temukan kompetisi yang layak kamu kejar.</h1>
            <p>
              Cari berdasarkan judul, lalu saring arena yang paling sesuai dengan minat dan waktumu.
            </p>
          </div>

          <CompetitionSearchForm params={params} />
        </div>
      </section>

      <div className="page-shell discovery-page">
        <section className="stack-lg" aria-labelledby="competition-results-title">
          <div className="glass-chrome filter-toolbar">
            <div>
              <p className="eyebrow">Hasil pencarian</p>
              <h2 id="competition-results-title" className="filter-result-title">
                {meta.total} kompetisi ditemukan
              </h2>
            </div>
            <CompetitionFilterBar params={params} />
          </div>

          {competitions.length === 0 ? (
            <div className="empty-state">
              <span className="empty-state-icon" aria-hidden="true">
                <Icon name="search" size="xl" />
              </span>
              <h2>Belum ada hasil yang cocok.</h2>
              <p>Coba kata kunci yang lebih luas atau kembalikan kategori ke semua kompetisi.</p>
              <ButtonLink href="/competitions" variant="outline">
                Bersihkan filter
              </ButtonLink>
            </div>
          ) : (
            <div className="competition-grid">
              {competitions.map((competition) => (
                <CompetitionCard key={competition.id} competition={competition} />
              ))}
            </div>
          )}

          <Pagination
            page={meta.page}
            totalPages={meta.totalPages}
            label="Halaman hasil kompetisi"
            hrefFor={(target) => competitionsHref(params, { page: String(target) })}
          />
        </section>
      </div>
    </main>
  );
}
