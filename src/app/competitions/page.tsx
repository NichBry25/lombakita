"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Icon, Pagination, SkeletonCard } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { CompetitionCard } from "@/components/competitions/competition-card";
import { CompetitionFilters } from "./competition-filters";

type Competition = {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string | null;
  mode: string | null;
  registrationEndAt: string | null;
  eventStartAt: string | null;
  publishedAt: string | null;
  isFeatured: boolean;
  institutionSlug: string;
  institutionName: string;
};

type Meta = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  searchEngine: "meilisearch" | "db";
};

export default function PublicCompetitionsPage() {
  const { addToast } = useToast();
  const [items, setItems] = useState<Competition[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [mode, setMode] = useState("");
  const [status, setStatus] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [sort, setSort] = useState("created_desc");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setIsLoading(true);

    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (category) params.set("category", category);
    if (mode) params.set("mode", mode);
    if (status) params.set("status", status);
    if (teamSize) params.set("teamSize", teamSize);
    params.set("sort", sort);
    params.set("page", String(page));

    try {
      const res = await fetch(`/api/v1/competitions?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        addToast({ type: "error", message: "Gagal memuat kompetisi." });
        setIsLoading(false);
        return;
      }
      const data = (await res.json()) as { data: Competition[]; meta: Meta };
      setItems(data.data);
      setMeta(data.meta);
    } catch {
      addToast({ type: "error", message: "Gagal memuat kompetisi." });
    } finally {
      setIsLoading(false);
    }
  }, [q, category, mode, status, teamSize, sort, page, addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setPage(1);
  };

  function clearFilters() {
    setQ("");
    setCategory("");
    setMode("");
    setStatus("");
    setTeamSize("");
    setSort("created_desc");
    setPage(1);
  }

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

          <form className="glass-focus listing-search" onSubmit={handleSearch} role="search">
            <Icon name="search" size="lg" />
            <label className="sr-only" htmlFor="competition-search">
              Cari kompetisi
            </label>
            <input
              id="competition-search"
              type="search"
              placeholder="Cari judul atau kata kunci…"
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
                setPage(1);
              }}
              aria-label="Cari kompetisi"
            />
            <Button type="submit" variant="secondary" size="lg">
              Cari
            </Button>
          </form>
        </div>
      </section>

      <div className="page-shell discovery-page">
        <section className="stack-lg" aria-labelledby="competition-results-title">
          <div className="glass-chrome filter-toolbar">
            <div>
              <p className="eyebrow">Hasil pencarian</p>
              <h2 id="competition-results-title" className="filter-result-title" aria-live="polite">
                {isLoading
                  ? "Menyiapkan pilihan…"
                  : `${meta?.total ?? items.length} kompetisi ditemukan`}
              </h2>
            </div>
            <CompetitionFilters
              category={category}
              mode={mode}
              status={status}
              teamSize={teamSize}
              sort={sort}
              onCategory={(value) => {
                setCategory(value);
                setPage(1);
              }}
              onMode={(value) => {
                setMode(value);
                setPage(1);
              }}
              onStatus={(value) => {
                setStatus(value);
                setPage(1);
              }}
              onTeamSize={(value) => {
                setTeamSize(value);
                setPage(1);
              }}
              onSort={(value) => {
                setSort(value);
                setPage(1);
              }}
            />
          </div>

          {isLoading ? (
            <div className="competition-grid" aria-label="Memuat kompetisi">
              {Array.from({ length: 6 }, (_, index) => (
                <SkeletonCard key={index} />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              <span className="empty-state-icon" aria-hidden="true">
                <Icon name="search" size="xl" />
              </span>
              <h2>Belum ada hasil yang cocok.</h2>
              <p>Coba kata kunci yang lebih luas atau kembalikan kategori ke semua kompetisi.</p>
              <Button variant="outline" onClick={clearFilters}>
                Bersihkan filter
              </Button>
            </div>
          ) : (
            <div className="competition-grid">
              {items.map((competition) => (
                <CompetitionCard key={competition.id} competition={competition} />
              ))}
            </div>
          )}

          {meta ? (
            <Pagination
              page={meta.page}
              totalPages={meta.totalPages}
              label="Halaman hasil kompetisi"
              onPageChange={setPage}
            />
          ) : null}
        </section>
      </div>
    </main>
  );
}
