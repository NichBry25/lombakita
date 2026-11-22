"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ButtonLink,
  CountPill,
  EmptyState,
  FilterDropdown,
  Icon,
  IconButtonLink,
  LinkCard,
  PageHeader,
  PageSection,
  Skeleton,
} from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { getCompetitionStatusLabel } from "@/lib/competitions/status-labels";

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

const COMPETITION_LIST_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "Anda tidak memiliki akses ke kompetisi institusi ini.",
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { code?: string } };
    const code = payload.error?.code;
    const message = code ? COMPETITION_LIST_ERROR_MESSAGES[code] : undefined;
    return message ?? "Permintaan gagal diproses.";
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
    let response: Response;
    try {
      response = await fetch(
        `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions`,
        { cache: "no-store", credentials: "include" },
      );
    } catch {
      addToast({ type: "error", message: "Gagal mengirim permintaan karena gangguan koneksi." });
      setIsLoading(false);
      return;
    }
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
        action={{
          kind: "icon",
          control: (
            <IconButtonLink
              href={`/institution/${institutionSlug}/competitions/new`}
              icon="plus"
              label="Buat kompetisi"
              variant="fill"
            />
          ),
        }}
      />

      <PageSection
        title="Kompetisi tersimpan"
        action={
          <div className="competition-list-controls">
            <FilterDropdown
              label="Status"
              options={FILTER_OPTIONS}
              value={filter}
              onChange={(value) => setFilter(value as CompetitionListFilter)}
            />
            <CountPill count={visibleItems.length} />
          </div>
        }
      >
        {isLoading ? (
          <div className="stack-sm" aria-label="Memuat kompetisi">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        ) : visibleItems.length === 0 ? (
          items.length === 0 ? (
            <EmptyState
              kind="nothing-yet"
              size="compact"
              title="Belum ada kompetisi"
              description="Draf kompetisi yang kamu buat akan muncul di sini."
              action={{
                label: "Buat draf pertama",
                href: `/institution/${institutionSlug}/competitions/new`,
              }}
            />
          ) : (
            <EmptyState
              kind="no-match"
              size="compact"
              title="Belum ada kompetisi yang cocok"
              description="Coba pilih status lain."
              action={{ label: "Tampilkan semua", onSelect: () => setFilter("all") }}
            />
          )
        ) : (
          <ul className="management-competition-list">
            {visibleItems.map((c) => (
              <LinkCard
                key={c.id}
                as="li"
                href={`/institution/${institutionSlug}/competitions/${c.slug}`}
                title={c.title}
                trailing={
                  <>
                    <span
                      className="status-badge"
                      data-status={
                        hasFinished(c, loadedAt)
                          ? "closed"
                          : c.status === "published"
                            ? "open"
                            : "awaiting"
                      }
                    >
                      {hasFinished(c, loadedAt) ? "Selesai" : getCompetitionStatusLabel(c.status)}
                    </span>
                    {c.status === "draft" ? (
                      <ButtonLink
                        href={`/institution/${institutionSlug}/competitions/${c.slug}/edit`}
                        variant="outline"
                        size="sm"
                      >
                        Lanjutkan
                      </ButtonLink>
                    ) : (
                      <ButtonLink
                        href={`/institution/${institutionSlug}/competitions/${c.slug}/participants`}
                        variant="link"
                        size="sm"
                        leadingIcon={<Icon name="users" size="sm" />}
                      >
                        Peserta
                      </ButtonLink>
                    )}
                  </>
                }
              >
                <span className="record-meta data-text">/{c.slug}</span>
              </LinkCard>
            ))}
          </ul>
        )}
      </PageSection>
    </main>
  );
};
