"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

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

const CATEGORY_LABELS: Record<string, string> = {
  technology: "Teknologi",
  science: "Sains",
  business: "Bisnis",
  creative_arts: "Seni & Kreasi",
  social_humanities: "Sosial & Humaniora",
  sports: "Olahraga",
  academic: "Akademik",
  other: "Lainnya",
};

const SORT_OPTIONS = [
  { value: "created_desc", label: "Terbaru" },
  { value: "deadline_asc", label: "Deadline Terdekat" },
  { value: "deadline_desc", label: "Deadline Terjauh" },
];

export default function PublicCompetitionsPage() {
  const [items, setItems] = useState<Competition[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("created_desc");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (category) params.set("category", category);
    params.set("sort", sort);
    params.set("page", String(page));

    try {
      const res = await fetch(`/api/v1/competitions?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        setError("Gagal memuat kompetisi.");
        setIsLoading(false);
        return;
      }
      const data = (await res.json()) as { data: Competition[]; meta: Meta };
      setItems(data.data);
      setMeta(data.meta);
    } catch {
      setError("Gagal memuat kompetisi.");
    } finally {
      setIsLoading(false);
    }
  }, [q, category, sort, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
  };

  return (
    <main style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Kompetisi</h1>

      <form
        onSubmit={handleSearch}
        style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <input
          type="search"
          placeholder="Cari kompetisi..."
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          style={{
            flex: 1,
            minWidth: 200,
            padding: "6px 10px",
            border: "1px solid #ccc",
            borderRadius: 4,
          }}
          aria-label="Cari kompetisi"
        />
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(1);
          }}
          style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4 }}
          aria-label="Filter kategori"
        >
          <option value="">Semua Kategori</option>
          {Object.entries(CATEGORY_LABELS).map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setPage(1);
          }}
          style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4 }}
          aria-label="Urutan"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="submit" style={{ padding: "6px 16px", borderRadius: 4 }}>
          Cari
        </button>
      </form>

      <section style={{ marginTop: 24 }}>
        {isLoading ? (
          <p>Memuat...</p>
        ) : error ? (
          <p role="alert" style={{ color: "#b00" }}>
            {error}
          </p>
        ) : items.length === 0 ? (
          <p>Tidak ada kompetisi yang ditemukan.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((c) => (
              <li key={c.id} style={{ padding: "16px 0", borderBottom: "1px solid #eee" }}>
                <Link
                  href={`/competitions/${c.institutionSlug}/${c.slug}`}
                  style={{ fontWeight: 600, fontSize: 16 }}
                >
                  {c.title}
                </Link>
                <div style={{ fontSize: 13, color: "#555", marginTop: 4 }}>
                  {c.institutionName}
                  {c.category ? ` · ${CATEGORY_LABELS[c.category] ?? c.category}` : ""}
                  {c.registrationEndAt
                    ? ` · Deadline: ${new Date(c.registrationEndAt).toLocaleDateString("id-ID")}`
                    : ""}
                </div>
                {c.description ? (
                  <p style={{ fontSize: 14, margin: "6px 0 0", color: "#333" }}>
                    {c.description.length > 160 ? `${c.description.slice(0, 160)}…` : c.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {meta && meta.totalPages > 1 ? (
        <nav style={{ marginTop: 24, display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={{ padding: "4px 12px", borderRadius: 4 }}
          >
            ‹ Sebelumnya
          </button>
          <span style={{ fontSize: 13 }}>
            Halaman {meta.page} dari {meta.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
            disabled={page >= meta.totalPages}
            style={{ padding: "4px 12px", borderRadius: 4 }}
          >
            Berikutnya ›
          </button>
        </nav>
      ) : null}

      {meta ? (
        <p style={{ fontSize: 12, color: "#888", marginTop: 12 }}>
          {meta.total} kompetisi ditemukan
        </p>
      ) : null}
    </main>
  );
}
