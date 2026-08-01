"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  ButtonLink,
  EmptyState,
  Icon,
  IconButtonLink,
  PageHeader,
  SelectField,
  Skeleton,
} from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { capitalizeWord } from "@/lib/text/capitalize";

type Competition = {
  id: string;
  slug: string;
  title: string;
  status: "draft" | "published";
  eventEndAt: string | null;
  createdAt: string;
};

// Replaces what archiving used to do for an organizer: keep finished competitions out of the way
// without taking their public pages down. "Selesai" is derived from the event end date, so a
// competition moves into it on its own.
type CompetitionListFilter = "all" | "draft" | "published" | "finished";

const FILTER_OPTIONS: { value: CompetitionListFilter; label: string }[] = [
  { value: "all", label: "Semua" },
  { value: "draft", label: "Draf" },
  { value: "published", label: "Terbit" },
  { value: "finished", label: "Selesai" },
];

const hasFinished = (competition: Competition, now: number): boolean =>
  competition.eventEndAt !== null && new Date(competition.eventEndAt).getTime() < now;

const applyCompetitionFilter = (
  competitions: Competition[],
  filter: CompetitionListFilter,
  now: number,
): Competition[] => {
  if (filter === "all") return competitions;
  if (filter === "finished") return competitions.filter((c) => hasFinished(c, now));
  // A finished competition is still published; the status filters name what an organizer is
  // actively working on, so finished ones drop out of "Terbit".
  return competitions.filter((c) => c.status === filter && !hasFinished(c, now));
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message ?? "Permintaan gagal diproses.";
  } catch {
    return "Permintaan gagal diproses.";
  }
};

export const InstitutionCompetitionsShell = ({ institutionSlug }: { institutionSlug: string }) => {
  const [items, setItems] = useState<Competition[]>([]);
  const [filter, setFilter] = useState<CompetitionListFilter>("all");
  const [isLoading, setIsLoading] = useState(true);
  // Captured when the list loads rather than read during render, so rendering stays pure and
  // every row is classified against one consistent instant.
  const [loadedAt, setLoadedAt] = useState(0);
  const { addToast } = useToast();

  const visibleItems = useMemo(
    () => applyCompetitionFilter(items, filter, loadedAt),
    [items, filter, loadedAt],
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(
      `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions`,
      { cache: "no-store", credentials: "include" },
    );
    if (!response.ok) {
      const message = await extractErrorMessage(response);
      addToast({ type: "error", message });
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as { competitions: Competition[] };
    setItems(data.competitions);
    setLoadedAt(Date.now());
    setIsLoading(false);
  }, [institutionSlug, addToast]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  return (
    <main className="page-shell app-page competition-management-page">
      <PageHeader
        title="Kompetisi"
        description={`Kelola seluruh kompetisi yang diterbitkan melalui ${institutionSlug}.`}
        backHref={`/institution/${institutionSlug}`}
        backLabel="Kembali"
        actions={
          <IconButtonLink
            href={`/institution/${institutionSlug}/competitions/new`}
            icon="plus"
            label="Buat kompetisi"
            variant="primary"
            size="sm"
          />
        }
      />

      <section className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Daftar workspace</p>
            <h2>Kompetisi tersimpan</h2>
          </div>
          <div className="competition-list-controls">
            <SelectField
              label="Saring kompetisi"
              options={FILTER_OPTIONS}
              value={filter}
              onChange={(value) => setFilter(value as CompetitionListFilter)}
            />
            <span className="status-badge data-text">{visibleItems.length}</span>
          </div>
        </div>
        {isLoading ? (
          <div className="stack-sm" aria-label="Memuat kompetisi">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : visibleItems.length === 0 ? (
          items.length === 0 ? (
            <EmptyState
              icon="trophy"
              title="Belum ada kompetisi."
              description="Mulai dari draf baru, lalu lengkapi seluruh informasi sebelum diterbitkan."
              action={
                <ButtonLink
                  href={`/institution/${institutionSlug}/competitions/new`}
                  variant="primary"
                >
                  Buat draf pertama
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState
              icon="trophy"
              title="Tidak ada kompetisi pada saringan ini."
              description="Kompetisi lain masih tersimpan. Ubah saringan untuk melihatnya."
              action={
                <Button variant="outline" onClick={() => setFilter("all")}>
                  Tampilkan semua
                </Button>
              }
            />
          )
        ) : (
          <ul className="management-competition-list">
            {visibleItems.map((c) => (
              <li key={c.id} className="management-competition-card">
                <span className="management-competition-mark" aria-hidden="true">
                  <Icon name="trophy" size="md" />
                </span>
                <div className="record-row-main">
                  <Link
                    href={`/institution/${institutionSlug}/competitions/${c.slug}`}
                    className="record-row-title"
                  >
                    {c.title}
                  </Link>
                  <span className="record-meta data-text">/{c.slug}</span>
                </div>
                <span
                  className="status-badge"
                  data-status={
                    hasFinished(c, loadedAt)
                      ? "closed"
                      : c.status === "published"
                        ? "open"
                        : "closing"
                  }
                >
                  {hasFinished(c, loadedAt) ? "Selesai" : capitalizeWord(c.status)}
                </span>
                <ButtonLink
                  href={`/institution/${institutionSlug}/competitions/${c.slug}/participants`}
                  variant="outline"
                  size="sm"
                >
                  Peserta
                </ButtonLink>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
};
