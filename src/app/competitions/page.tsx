"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button, Icon, SkeletonCard } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { getCompetitionCategoryLabel } from "@/lib/competitions/categories";
import { getCompetitionModeLabel } from "@/lib/competitions/modes";
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

function formatDeadline(value: string | null) {
  if (!value) return "Tanpa batas waktu";
  return new Date(value).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function resolveRegistrationStatus(value: string | null) {
  if (!value) return { value: "open", label: "Dibuka" } as const;

  const millisecondsRemaining = new Date(value).getTime() - Date.now();
  if (millisecondsRemaining <= 0) return { value: "closed", label: "Ditutup" } as const;
  if (millisecondsRemaining < 7 * 24 * 60 * 60 * 1000) {
    return { value: "closing", label: "Segera ditutup" } as const;
  }
  return { value: "open", label: "Dibuka" } as const;
}

function truncateDescription(description: string) {
  return description.length > 160 ? `${description.slice(0, 160)}…` : description;
}

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
            <p className="eyebrow">Discovery</p>
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
              {items.map((competition) => {
                const detailPath = `/competitions/${competition.institutionSlug}/${competition.slug}`;
                const registrationStatus = resolveRegistrationStatus(competition.registrationEndAt);
                return (
                  <article className="competition-card" key={competition.id}>
                    <Link
                      href={detailPath}
                      className="competition-cover"
                      data-category={competition.category ?? "other"}
                      aria-label={`Buka ${competition.title}`}
                    >
                      <span className="competition-cover-icon" aria-hidden="true">
                        <Icon name="trophy" size="lg" />
                      </span>
                      <span className="competition-cover-label">
                        {competition.category
                          ? getCompetitionCategoryLabel(competition.category)
                          : "Kompetisi"}
                      </span>
                    </Link>

                    <div className="competition-card-body">
                      <div className="competition-card-badges">
                        {competition.isFeatured ? (
                          <span className="status-badge" data-status="featured">
                            Pilihan editor
                          </span>
                        ) : null}
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
                          {registrationStatus.label} ·{" "}
                          {formatDeadline(competition.registrationEndAt)}
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
          )}

          {meta && meta.totalPages > 1 ? (
            <nav className="pagination" aria-label="Halaman hasil kompetisi">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
                disabled={page <= 1}
              >
                Sebelumnya
              </Button>
              <span className="pagination-status data-text">
                Halaman {meta.page} / {meta.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((currentPage) => Math.min(meta.totalPages, currentPage + 1))}
                disabled={page >= meta.totalPages}
              >
                Berikutnya
              </Button>
            </nav>
          ) : null}
        </section>
      </div>
    </main>
  );
}
